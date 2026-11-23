import { createHash } from "node:crypto";
import http, { type Server } from "node:http";
import { Readable } from "node:stream";
import {
  StorageError,
  type StorageObjectKey,
  type StorageProvider,
  type StorageProviderKind,
  type StoredObject,
  normalizeStorageError,
} from "../../src/index.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertSafeObjectKey(rawKey: string, providerKind: StorageProviderKind): string {
  if (
    rawKey.length === 0 ||
    rawKey.length > 512 ||
    rawKey.trim() !== rawKey ||
    rawKey.startsWith("/") ||
    rawKey.endsWith("/") ||
    rawKey.includes("\\") ||
    rawKey.includes("\0")
  ) {
    throw new StorageError("INVALID_KEY", "Chave de objeto inválida.", providerKind);
  }
  const segments = rawKey.split("/");
  if (segments.some((seg) => seg.length === 0 || seg === "." || seg === "..")) {
    throw new StorageError("INVALID_KEY", "Chave de objeto inválida.", providerKind);
  }
  return rawKey;
}

export interface ReferenceContractConnectorHandle {
  readonly provider: StorageProvider;
  close(): Promise<void>;
}

interface StoredMemoryRecord {
  readonly data: Buffer;
  readonly metadata: StoredObject;
}

/**
 * Creates a contract reference connector implementing the exact `StorageProvider`
 * contract (streaming only for `"local"`, or signed-target capable HTTP endpoint for `"s3"`).
 */
export async function createReferenceContractConnector(options: {
  readonly kind: "local" | "s3";
  readonly enableSignedTargets?: boolean | undefined;
}): Promise<ReferenceContractConnectorHandle> {
  const store = new Map<string, StoredMemoryRecord>();
  const signedEnabled = options.enableSignedTargets === true;

  let server: Server | null = null;
  let baseUrl = "";

  if (signedEnabled) {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const key = decodeURIComponent(url.searchParams.get("key") ?? "");

      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const buf = Buffer.concat(chunks);
          const checksum = sha256Hex(buf);
          store.set(key, {
            data: buf,
            metadata: {
              key: { value: key },
              contentType: req.headers["content-type"] ?? "application/octet-stream",
              contentLength: buf.length,
              checksumSha256: checksum,
            },
          });
          res.writeHead(200);
          res.end();
        });
        return;
      }

      if (req.method === "GET") {
        const entry = store.get(key);
        if (!entry) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": entry.metadata.contentType,
          "Content-Length": String(entry.data.length),
        });
        res.end(entry.data);
        return;
      }

      res.writeHead(405);
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (address && typeof address === "object") {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  }

  const baseProvider: StorageProvider = {
    kind: options.kind,
    capabilities: {
      streamingRead: true,
      streamingWrite: true,
      signedUpload: signedEnabled,
      signedDownload: signedEnabled,
      multipartUpload: options.kind === "s3",
      serverSideCopy: options.kind === "s3",
    },

    async checkHealth() {
      return {
        healthy: true,
        message: "Conector de referência operacional.",
        checkedAt: new Date(),
      };
    },

    async putObject(input) {
      const normalizedKey = assertSafeObjectKey(input.key.value, options.kind);
      if (input.abortSignal?.aborted) {
        input.body.destroy();
        throw new StorageError("TIMEOUT", "Operação abortada antes da leitura.", options.kind);
      }

      const chunks: Buffer[] = [];
      const onAbort = (): void => {
        input.body.destroy(
          new StorageError("TIMEOUT", "Upload cancelado durante streaming.", options.kind),
        );
      };
      input.abortSignal?.addEventListener("abort", onAbort, { once: true });

      try {
        for await (const chunk of input.body) {
          if (input.abortSignal?.aborted) {
            throw new StorageError("TIMEOUT", "Upload cancelado durante streaming.", options.kind);
          }
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
      } catch (err) {
        if (input.abortSignal?.aborted) {
          throw new StorageError("TIMEOUT", "Upload cancelado durante streaming.", options.kind);
        }
        throw normalizeStorageError(err, options.kind);
      } finally {
        input.abortSignal?.removeEventListener("abort", onAbort);
      }

      if (input.abortSignal?.aborted) {
        throw new StorageError("TIMEOUT", "Upload cancelado durante streaming.", options.kind);
      }

      const buffer = Buffer.concat(chunks);
      const actualChecksum = sha256Hex(buffer);
      if (
        !SHA256_PATTERN.test(input.metadata.checksumSha256) ||
        actualChecksum !== input.metadata.checksumSha256.toLowerCase()
      ) {
        throw new StorageError(
          "CHECKSUM_MISMATCH",
          "Checksum SHA-256 diverge do conteúdo recebido.",
          options.kind,
        );
      }

      const stored: StoredObject = {
        key: { value: normalizedKey },
        contentType: input.metadata.contentType,
        contentLength: buffer.length,
        checksumSha256: actualChecksum,
        customMetadata: input.metadata.customMetadata,
      };
      store.set(normalizedKey, { data: buffer, metadata: stored });
      return stored;
    },

    async getObject(key: StorageObjectKey) {
      const normalizedKey = assertSafeObjectKey(key.value, options.kind);
      const entry = store.get(normalizedKey);
      if (!entry) {
        throw new StorageError("NOT_FOUND", "Objeto não encontrado.", options.kind);
      }
      return {
        body: Readable.from(entry.data.length > 0 ? [entry.data] : []),
        metadata: entry.metadata,
      };
    },

    async headObject(key: StorageObjectKey) {
      const normalizedKey = assertSafeObjectKey(key.value, options.kind);
      return store.get(normalizedKey)?.metadata ?? null;
    },

    async deleteObject(key: StorageObjectKey) {
      const normalizedKey = assertSafeObjectKey(key.value, options.kind);
      store.delete(normalizedKey);
    },

    ...(signedEnabled
      ? {
          async createSignedUploadTarget(input) {
            const normalizedKey = assertSafeObjectKey(input.key.value, options.kind);
            return {
              url: `${baseUrl}/upload?key=${encodeURIComponent(normalizedKey)}`,
              method: "PUT" as const,
              headers: { "Content-Type": input.contentType },
              expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
            };
          },
          async createSignedDownloadTarget(input) {
            const normalizedKey = assertSafeObjectKey(input.key.value, options.kind);
            return {
              url: `${baseUrl}/download?key=${encodeURIComponent(normalizedKey)}`,
              method: "GET" as const,
              headers: {},
              expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
            };
          },
        }
      : {}),
  };

  return {
    provider: baseProvider,
    async close() {
      if (!server) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
