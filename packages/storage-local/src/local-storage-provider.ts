import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type StorageCapabilities,
  StorageError,
  type StorageObjectMetadata,
  type StorageProvider,
  type StorageUploadInput,
  type StoredObject,
  normalizeStorageError,
} from "@docuflow/storage-core";
import { resolveSafeLocalPath } from "./safe-path.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const META_DIR_NAME = ".docuflow-meta";

export interface LocalStorageProviderConfig {
  readonly rootDirectory: string;
  readonly maxObjectSizeBytes?: number | undefined;
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

const LOCAL_CAPABILITIES_WRITE_ONLY: StorageCapabilities = {
  streamingRead: false,
  streamingWrite: true,
  signedUpload: false,
  signedDownload: false,
  multipartUpload: false,
  serverSideCopy: false,
};

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

export function createLocalStorageProvider(config: LocalStorageProviderConfig): StorageProvider {
  const shouldOverwrite = config.overwrite ?? true;
  const shouldFsync = config.fsync ?? true;

  return {
    kind: "local",
    capabilities: LOCAL_CAPABILITIES_WRITE_ONLY,

    async checkHealth() {
      throw new StorageError(
        "CAPABILITY_NOT_SUPPORTED",
        "Verificação de saúde do filesystem local ainda não habilitada nesta versão do provedor.",
        "local",
      );
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

    async getObject() {
      throw new StorageError(
        "CAPABILITY_NOT_SUPPORTED",
        "Leitura local ainda não habilitada nesta versão do provedor.",
        "local",
      );
    },

    async headObject() {
      throw new StorageError(
        "CAPABILITY_NOT_SUPPORTED",
        "Inspeção local de metadados ainda não habilitada nesta versão do provedor.",
        "local",
      );
    },

    async deleteObject() {
      throw new StorageError(
        "CAPABILITY_NOT_SUPPORTED",
        "Exclusão local ainda não habilitada nesta versão do provedor.",
        "local",
      );
    },
  };
}
