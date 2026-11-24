import { createHash, randomUUID } from "node:crypto";
import { type Stats, createReadStream, createWriteStream } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type StorageCapabilities,
  type StorageDownload,
  StorageError,
  type StorageObjectKey,
  type StorageObjectMetadata,
  type StorageProvider,
  type StorageUploadInput,
  type StoredObject,
  normalizeStorageError,
} from "@papyrus/storage-core";
import { checkLocalStorageHealth } from "./local-health.js";
import { resolveSafeLocalPath } from "./safe-path.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const META_DIR_NAME = ".papyrus-meta";
const LEGACY_META_DIR_NAME = ".docuflow-meta";

export interface LocalStorageProviderConfig {
  readonly rootDirectory: string;
  readonly maxObjectSizeBytes?: number | undefined;
  readonly minFreeBytes?: number | undefined;
  readonly overwrite?: boolean | undefined;
  readonly fsync?: boolean | undefined;
}

interface StoredObjectMetaSidecar {
  readonly contentType: string;
  readonly contentLength: number;
  readonly checksumSha256: string;
  readonly customMetadata?: Readonly<Record<string, string>> | undefined;
  readonly etag: string;
}

const LOCAL_CAPABILITIES: StorageCapabilities = {
  streamingRead: true,
  streamingWrite: true,
  signedUpload: false,
  signedDownload: false,
  multipartUpload: false,
  serverSideCopy: false,
};

function isErrnoCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === expectedCode
  );
}

async function computeFileSha256Stream(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function isValidSidecarPayload(raw: unknown): raw is StoredObjectMetaSidecar {
  if (typeof raw !== "object" || raw === null) {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.contentType === "string" &&
    typeof obj.contentLength === "number" &&
    Number.isInteger(obj.contentLength) &&
    obj.contentLength >= 0 &&
    typeof obj.checksumSha256 === "string" &&
    SHA256_HEX_PATTERN.test(obj.checksumSha256) &&
    typeof obj.etag === "string"
  );
}

async function readSidecarFile(
  metaPath: string,
  actualSize: number,
): Promise<StoredObjectMetaSidecar | null> {
  try {
    const handle = await open(metaPath, "r");
    try {
      const content = await handle.readFile("utf8");
      const parsed: unknown = JSON.parse(content);
      if (!isValidSidecarPayload(parsed)) {
        throw new StorageError(
          "UNKNOWN",
          "Arquivo de metadados do objeto local está corrompido.",
          "local",
        );
      }
      if (parsed.contentLength !== actualSize) {
        throw new StorageError(
          "CHECKSUM_MISMATCH",
          "Tamanho do arquivo local diverge dos metadados armazenados.",
          "local",
        );
      }
      return parsed;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    if (isErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw normalizeStorageError(error, "local");
  }
}

async function readMetadataSidecar(
  rootRealPath: string,
  normalizedKey: string,
  actualSize: number,
  targetPath: string,
): Promise<StoredObjectMetaSidecar> {
  const primaryPath = path.join(rootRealPath, META_DIR_NAME, `${normalizedKey}.json`);
  const primary = await readSidecarFile(primaryPath, actualSize);
  if (primary) {
    return primary;
  }

  const legacyPath = path.join(rootRealPath, LEGACY_META_DIR_NAME, `${normalizedKey}.json`);
  const legacy = await readSidecarFile(legacyPath, actualSize);
  if (legacy) {
    return legacy;
  }

  const checksumSha256 = await computeFileSha256Stream(targetPath);
  return {
    contentType: "application/octet-stream",
    contentLength: actualSize,
    checksumSha256,
    etag: checksumSha256,
  };
}

async function assertNoSymlinkParent(
  rootRealPath: string,
  targetParentPath: string,
): Promise<void> {
  const relativeParent = path.relative(rootRealPath, targetParentPath);
  if (!relativeParent || relativeParent === ".") {
    return;
  }

  let cursor = rootRealPath;
  for (const segment of relativeParent.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stats = await lstat(cursor);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new StorageError(
        "INVALID_KEY",
        "Diretório pai inválido ou link simbólico detectado durante a gravação.",
        "local",
      );
    }
  }
}

async function syncFileToDisk(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeMetadataSidecar(
  rootRealPath: string,
  normalizedKey: string,
  meta: StoredObjectMetaSidecar,
  shouldFsync: boolean,
): Promise<void> {
  const metaTargetPath = path.join(rootRealPath, META_DIR_NAME, `${normalizedKey}.json`);
  const metaDir = path.dirname(metaTargetPath);
  await mkdir(metaDir, { recursive: true, mode: 0o750 });

  const metaTempPath = path.join(metaDir, `.tmp-${randomUUID()}.json`);
  try {
    const payload = JSON.stringify(meta);
    const handle = await open(metaTempPath, "wx", 0o640);
    try {
      await handle.writeFile(payload, "utf8");
      if (shouldFsync) {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
    await rename(metaTempPath, metaTargetPath);
  } catch (error) {
    await rm(metaTempPath, { force: true });
    throw error;
  }
}

function validateUploadMetadata(
  metadata: StorageObjectMetadata,
  maxObjectSizeBytes?: number,
): string {
  if (!Number.isInteger(metadata.contentLength) || metadata.contentLength < 0) {
    throw new StorageError(
      "CONFLICT",
      "Tamanho declarado do objeto é inválido para armazenamento.",
      "local",
    );
  }

  if (maxObjectSizeBytes !== undefined && metadata.contentLength > maxObjectSizeBytes) {
    throw new StorageError(
      "CONFLICT",
      "Objeto excede o tamanho máximo configurado para este conector.",
      "local",
    );
  }

  const normalizedChecksum = metadata.checksumSha256.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalizedChecksum)) {
    throw new StorageError(
      "CHECKSUM_MISMATCH",
      "Checksum SHA-256 esperado possui formato inválido.",
      "local",
    );
  }

  return normalizedChecksum;
}

async function statLocalObjectOrNull(targetPath: string): Promise<Stats | null> {
  let stats: Stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw normalizeStorageError(error, "local");
  }

  if (!stats.isFile()) {
    throw new StorageError(
      "INVALID_KEY",
      "O caminho de destino no armazenamento local não é um arquivo regular.",
      "local",
    );
  }

  return stats;
}

async function openLocalObjectForRead(targetPath: string): Promise<FileHandle> {
  try {
    return await open(targetPath, "r");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new StorageError("NOT_FOUND", "Objeto não encontrado no armazenamento.", "local");
    }
    throw normalizeStorageError(error, "local");
  }
}

export function createLocalStorageProvider(config: LocalStorageProviderConfig): StorageProvider {
  const shouldOverwrite = config.overwrite ?? true;
  const shouldFsync = config.fsync ?? true;

  return {
    kind: "local",
    capabilities: LOCAL_CAPABILITIES,

    async checkHealth() {
      const result = await checkLocalStorageHealth({
        rootDirectory: config.rootDirectory,
        minFreeBytes: config.minFreeBytes,
      });
      return {
        healthy: result.healthy,
        message: result.message,
        checkedAt: result.checkedAt,
      };
    },

    async putObject(input: StorageUploadInput): Promise<StoredObject> {
      if (input.abortSignal?.aborted) {
        input.body.destroy();
        throw new StorageError(
          "TIMEOUT",
          "Operação de escrita cancelada antes do início do envio.",
          "local",
        );
      }

      const expectedChecksum = validateUploadMetadata(input.metadata, config.maxObjectSizeBytes);

      const resolved = await resolveSafeLocalPath(config.rootDirectory, input.key.value);

      if (!shouldOverwrite) {
        try {
          await lstat(resolved.targetPath);
          throw new StorageError(
            "CONFLICT",
            "Já existe um objeto gravado para esta chave de armazenamento.",
            "local",
          );
        } catch (error) {
          if (error instanceof StorageError) {
            throw error;
          }
        }
      }

      await mkdir(resolved.parentDirPath, { recursive: true, mode: 0o750 });
      await assertNoSymlinkParent(resolved.rootRealPath, resolved.parentDirPath);

      const tempFilePath = path.join(resolved.parentDirPath, `.tmp-${randomUUID()}`);
      const hasher = createHash("sha256");
      let bytesWritten = 0;
      const maxSize = config.maxObjectSizeBytes;

      const inspectionTransform = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesWritten += chunk.length;
          if (maxSize !== undefined && bytesWritten > maxSize) {
            callback(
              new StorageError(
                "CONFLICT",
                "Stream excedeu o tamanho máximo permitido durante a gravação.",
                "local",
              ),
            );
            return;
          }
          hasher.update(chunk);
          callback(null, chunk);
        },
      });

      const writeStream = createWriteStream(tempFilePath, {
        flags: "wx",
        mode: 0o640,
      });

      try {
        if (input.abortSignal) {
          await pipeline(input.body, inspectionTransform, writeStream, {
            signal: input.abortSignal,
          });
        } else {
          await pipeline(input.body, inspectionTransform, writeStream);
        }

        if (bytesWritten !== input.metadata.contentLength) {
          throw new StorageError(
            "CHECKSUM_MISMATCH",
            "Quantidade de bytes gravados diverge do tamanho declarado.",
            "local",
          );
        }

        const computedChecksum = hasher.digest("hex");
        if (computedChecksum !== expectedChecksum) {
          throw new StorageError(
            "CHECKSUM_MISMATCH",
            "Checksum SHA-256 calculado diverge do esperado.",
            "local",
          );
        }

        if (shouldFsync) {
          await syncFileToDisk(tempFilePath);
        }

        await rename(tempFilePath, resolved.targetPath);

        const etag = computedChecksum;
        await writeMetadataSidecar(
          resolved.rootRealPath,
          resolved.normalizedKey,
          {
            contentType: input.metadata.contentType,
            contentLength: bytesWritten,
            checksumSha256: computedChecksum,
            customMetadata: input.metadata.customMetadata,
            etag,
          },
          shouldFsync,
        );

        return {
          key: { value: resolved.normalizedKey },
          contentType: input.metadata.contentType,
          contentLength: bytesWritten,
          checksumSha256: computedChecksum,
          customMetadata: input.metadata.customMetadata,
          etag,
        };
      } catch (error) {
        await rm(tempFilePath, { force: true });
        if (error instanceof StorageError) {
          throw error;
        }
        throw normalizeStorageError(error, "local");
      }
    },

    async getObject(key: StorageObjectKey): Promise<StorageDownload> {
      const resolved = await resolveSafeLocalPath(config.rootDirectory, key.value);
      const stats = await statLocalObjectOrNull(resolved.targetPath);
      if (!stats) {
        throw new StorageError("NOT_FOUND", "Objeto não encontrado no armazenamento.", "local");
      }

      const handle = await openLocalObjectForRead(resolved.targetPath);
      try {
        const meta = await readMetadataSidecar(
          resolved.rootRealPath,
          resolved.normalizedKey,
          stats.size,
          resolved.targetPath,
        );
        const body = handle.createReadStream();
        return {
          body,
          metadata: {
            contentType: meta.contentType,
            contentLength: meta.contentLength,
            checksumSha256: meta.checksumSha256,
            customMetadata: meta.customMetadata,
          },
        };
      } catch (error) {
        await handle.close();
        if (error instanceof StorageError) {
          throw error;
        }
        throw normalizeStorageError(error, "local");
      }
    },

    async headObject(key: StorageObjectKey): Promise<StoredObject | null> {
      const resolved = await resolveSafeLocalPath(config.rootDirectory, key.value);
      const stats = await statLocalObjectOrNull(resolved.targetPath);
      if (!stats) {
        return null;
      }

      const meta = await readMetadataSidecar(
        resolved.rootRealPath,
        resolved.normalizedKey,
        stats.size,
        resolved.targetPath,
      );

      return {
        key: { value: resolved.normalizedKey },
        contentType: meta.contentType,
        contentLength: meta.contentLength,
        checksumSha256: meta.checksumSha256,
        customMetadata: meta.customMetadata,
        etag: meta.etag,
      };
    },

    async deleteObject(key: StorageObjectKey): Promise<void> {
      const resolved = await resolveSafeLocalPath(config.rootDirectory, key.value);

      try {
        await unlink(resolved.targetPath);
      } catch (error) {
        if (!isErrnoCode(error, "ENOENT")) {
          throw normalizeStorageError(error, "local");
        }
      }

      for (const dirName of [META_DIR_NAME, LEGACY_META_DIR_NAME]) {
        const metaPath = path.join(
          resolved.rootRealPath,
          dirName,
          `${resolved.normalizedKey}.json`,
        );
        try {
          await unlink(metaPath);
        } catch (error) {
          if (!isErrnoCode(error, "ENOENT")) {
            throw normalizeStorageError(error, "local");
          }
        }
      }
    },
  };
}
