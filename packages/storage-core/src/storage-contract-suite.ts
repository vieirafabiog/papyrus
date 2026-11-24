import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  ALL_STORAGE_CAPABILITIES,
  assertStorageCapability,
  hasStorageCapability,
  requireSignedDownloadTargetProvider,
  requireSignedUploadTargetProvider,
  resolveDownloadMode,
  resolveUploadMode,
} from "./capability-validator.js";
import { StorageError, isRetryableStorageError, isStorageError } from "./storage-errors.js";
import type { StorageProvider } from "./storage-provider.js";
import type { StorageObjectKey } from "./storage.types.js";

export interface StorageContractContext {
  readonly provider: StorageProvider;
  readonly keyPrefix: string;
}

export interface StorageContractScenario {
  readonly name: string;
  run(context: StorageContractContext): Promise<void>;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildKey(prefix: string, suffix: string): StorageObjectKey {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return { value: `${cleanPrefix}/${suffix}` };
}

async function readAllBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Framework-agnostic contract test scenarios shared across all `StorageProvider`
 * implementations (local filesystem, S3-compatible, etc.).
 */
export function buildStorageProviderContractScenarios(): readonly StorageContractScenario[] {
  return [
    {
      name: "checkHealth reports healthy status with checkedAt timestamp",
      async run({ provider }) {
        const result = await provider.checkHealth();
        assert.equal(result.healthy, true);
        assert.ok(result.checkedAt instanceof Date);
        assert.ok(result.message.trim().length > 0);
      },
    },

    {
      name: "handles empty stream upload, headObject, getObject, and deleteObject",
      async run({ provider, keyPrefix }) {
        const key = buildKey(keyPrefix, "versions/1/empty-object");
        const empty = Buffer.alloc(0);
        const checksum = sha256Hex(empty);

        const stored = await provider.putObject({
          key,
          body: Readable.from([]),
          metadata: {
            contentType: "application/octet-stream",
            contentLength: 0,
            checksumSha256: checksum,
          },
        });

        assert.equal(stored.contentLength, 0);
        assert.equal(stored.checksumSha256, checksum);

        const head = await provider.headObject(key);
        assert.ok(head !== null);
        assert.equal(head.contentLength, 0);
        assert.equal(head.checksumSha256, checksum);

        const downloaded = await provider.getObject(key);
        const bytes = await readAllBytes(downloaded.body);
        assert.equal(bytes.length, 0);

        await provider.deleteObject(key);
        assert.equal(await provider.headObject(key), null);
      },
    },

    {
      name: "streams large multi-chunk payload without corruption",
      async run({ provider, keyPrefix }) {
        const key = buildKey(keyPrefix, "versions/1/large-object");
        const chunkCount = 40;
        const chunkSize = 64 * 1024; // 2.5 MiB total
        const chunks = Array.from({ length: chunkCount }, (_, i) =>
          Buffer.alloc(chunkSize, (i % 251) + 1),
        );
        const expected = Buffer.concat(chunks);
        const checksum = sha256Hex(expected);

        const stored = await provider.putObject({
          key,
          body: Readable.from(chunks),
          metadata: {
            contentType: "application/pdf",
            contentLength: expected.length,
            checksumSha256: checksum,
            customMetadata: { contract: "streaming-large" },
          },
        });

        assert.equal(stored.contentLength, expected.length);
        assert.equal(stored.checksumSha256, checksum);

        const head = await provider.headObject(key);
        assert.ok(head !== null);
        assert.equal(head.contentLength, expected.length);
        assert.equal(head.checksumSha256, checksum);

        const downloaded = await provider.getObject(key);
        const downloadedBytes = await readAllBytes(downloaded.body);
        assert.equal(downloadedBytes.length, expected.length);
        assert.equal(sha256Hex(downloadedBytes), checksum);

        await provider.deleteObject(key);
      },
    },

    {
      name: "cancels upload on abort signal and never exposes partial object",
      async run({ provider, keyPrefix }) {
        const preAbortedKey = buildKey(keyPrefix, "versions/1/pre-aborted");
        const preController = new AbortController();
        preController.abort();

        await assert.rejects(
          () =>
            provider.putObject({
              key: preAbortedKey,
              body: Readable.from([Buffer.from("aborted-before-start")]),
              metadata: {
                contentType: "text/plain",
                contentLength: 20,
                checksumSha256: sha256Hex(Buffer.from("aborted-before-start")),
              },
              abortSignal: preController.signal,
            }),
          (err: unknown) => err instanceof StorageError && err.code === "TIMEOUT",
        );
        assert.equal(await provider.headObject(preAbortedKey), null);

        const midAbortKey = buildKey(keyPrefix, "versions/1/mid-aborted");
        const midController = new AbortController();
        let emitted = 0;
        const slowBody = new Readable({
          read() {
            if (emitted === 0) {
              emitted += 1;
              this.push(Buffer.alloc(16 * 1024, 9));
              setTimeout(() => midController.abort(), 10);
            }
          },
        });

        await assert.rejects(
          () =>
            provider.putObject({
              key: midAbortKey,
              body: slowBody,
              metadata: {
                contentType: "application/octet-stream",
                contentLength: 64 * 1024,
                checksumSha256: "a".repeat(64),
              },
              abortSignal: midController.signal,
            }),
          (err: unknown) => err instanceof StorageError && err.code === "TIMEOUT",
        );
        assert.equal(await provider.headObject(midAbortKey), null);
      },
    },

    {
      name: "returns null for missing headObject and normalizes NOT_FOUND on getObject",
      async run({ provider, keyPrefix }) {
        const missingKey = buildKey(keyPrefix, "versions/1/does-not-exist");

        assert.equal(await provider.headObject(missingKey), null);
        await assert.rejects(
          () => provider.getObject(missingKey),
          (err: unknown) => err instanceof StorageError && err.code === "NOT_FOUND",
        );
        await provider.deleteObject(missingKey);
      },
    },

    {
      name: "rejects checksum mismatch without persisting corrupt object",
      async run({ provider, keyPrefix }) {
        const key = buildKey(keyPrefix, "versions/1/bad-checksum");
        const payload = Buffer.from("contrato-integridade-papyrus");

        await assert.rejects(
          () =>
            provider.putObject({
              key,
              body: Readable.from([payload]),
              metadata: {
                contentType: "text/plain",
                contentLength: payload.length,
                checksumSha256: "f".repeat(64),
              },
            }),
          (err: unknown) => err instanceof StorageError && err.code === "CHECKSUM_MISMATCH",
        );

        assert.equal(await provider.headObject(key), null);
      },
    },

    {
      name: "supports idempotent putObject and deleteObject re-execution",
      async run({ provider, keyPrefix }) {
        const key = buildKey(keyPrefix, "versions/1/idempotent-object");
        const payload = Buffer.from("conteudo-idempotente-v1");
        const checksum = sha256Hex(payload);

        const firstPut = await provider.putObject({
          key,
          body: Readable.from([payload]),
          metadata: {
            contentType: "text/plain",
            contentLength: payload.length,
            checksumSha256: checksum,
          },
        });
        const secondPut = await provider.putObject({
          key,
          body: Readable.from([payload]),
          metadata: {
            contentType: "text/plain",
            contentLength: payload.length,
            checksumSha256: checksum,
          },
        });

        assert.equal(firstPut.checksumSha256, checksum);
        assert.equal(secondPut.checksumSha256, checksum);

        const downloaded = await provider.getObject(key);
        const bytes = await readAllBytes(downloaded.body);
        assert.deepEqual(bytes, payload);

        await provider.deleteObject(key);
        await provider.deleteObject(key);
        assert.equal(await provider.headObject(key), null);
      },
    },

    {
      name: "declares consistent capabilities and enforces capability gates",
      async run({ provider }) {
        for (const capability of ALL_STORAGE_CAPABILITIES) {
          assert.equal(typeof provider.capabilities[capability], "boolean");
          const supported = hasStorageCapability(provider, capability);
          if (supported) {
            assert.doesNotThrow(() => assertStorageCapability(provider, capability));
          } else {
            assert.throws(
              () => assertStorageCapability(provider, capability),
              (err: unknown) =>
                isStorageError(err) &&
                err.code === "CAPABILITY_NOT_SUPPORTED" &&
                err.retryable === false &&
                err.providerKind === provider.kind,
            );
          }
        }

        const expectedUploadMode = hasStorageCapability(provider, "signedUpload")
          ? "SIGNED_UPLOAD"
          : "API_STREAMING";
        const expectedDownloadMode = hasStorageCapability(provider, "signedDownload")
          ? "SIGNED_DOWNLOAD"
          : "API_STREAMING";

        assert.equal(resolveUploadMode(provider, true), expectedUploadMode);
        assert.equal(resolveUploadMode(provider, false), "API_STREAMING");
        assert.equal(resolveDownloadMode(provider, true), expectedDownloadMode);
        assert.equal(resolveDownloadMode(provider, false), "API_STREAMING");

        if (expectedUploadMode === "API_STREAMING") {
          assert.throws(
            () => requireSignedUploadTargetProvider(provider),
            (err: unknown) =>
              isStorageError(err) &&
              err.code === "CAPABILITY_NOT_SUPPORTED" &&
              err.providerKind === provider.kind,
          );
        } else {
          const uploadCapable = requireSignedUploadTargetProvider(provider);
          assert.equal(typeof uploadCapable.createSignedUploadTarget, "function");
        }

        if (expectedDownloadMode === "API_STREAMING") {
          assert.throws(
            () => requireSignedDownloadTargetProvider(provider),
            (err: unknown) =>
              isStorageError(err) &&
              err.code === "CAPABILITY_NOT_SUPPORTED" &&
              err.providerKind === provider.kind,
          );
        } else {
          const downloadCapable = requireSignedDownloadTargetProvider(provider);
          assert.equal(typeof downloadCapable.createSignedDownloadTarget, "function");
        }
      },
    },

    {
      name: "executes signed upload and download round-trip when signed capabilities are enabled",
      async run({ provider, keyPrefix }) {
        if (
          !hasStorageCapability(provider, "signedUpload") ||
          !hasStorageCapability(provider, "signedDownload")
        ) {
          assert.throws(
            () => requireSignedUploadTargetProvider(provider),
            (err: unknown) => isStorageError(err) && err.code === "CAPABILITY_NOT_SUPPORTED",
          );
          return;
        }

        const uploadCapable = requireSignedUploadTargetProvider(provider);
        const downloadCapable = requireSignedDownloadTargetProvider(provider);
        const key = buildKey(keyPrefix, "versions/1/contract-signed-object");
        const payload = Buffer.from("contrato-signed-roundtrip-papyrus", "utf8");

        const uploadTarget = await uploadCapable.createSignedUploadTarget({
          key,
          contentType: "text/plain",
          contentLength: payload.length,
          expiresInSeconds: 60,
        });
        assert.ok(uploadTarget.expiresAt instanceof Date);

        const putRes = await fetch(uploadTarget.url, {
          method: uploadTarget.method,
          headers: uploadTarget.headers,
          body: payload,
        });
        assert.equal(putRes.ok, true);

        const downloadTarget = await downloadCapable.createSignedDownloadTarget({
          key,
          expiresInSeconds: 60,
          downloadName: "contrato-assinado.txt",
        });
        const getRes = await fetch(downloadTarget.url, { method: downloadTarget.method });
        assert.equal(getRes.ok, true);
        const downloaded = Buffer.from(await getRes.arrayBuffer());
        assert.deepEqual(downloaded, payload);

        await provider.deleteObject(key);
      },
    },

    {
      name: "rejects malformed or traversal object keys with normalized INVALID_KEY",
      async run({ provider }) {
        const invalidKeys = [
          "",
          "../escape",
          "org/../secret",
          "/leading/slash",
          "trailing/slash/",
          "a//b",
          "bad\\backslash",
          "null\0byte",
        ];

        for (const rawKey of invalidKeys) {
          const invalidKey: StorageObjectKey = { value: rawKey };
          const assertInvalidKeyError = (err: unknown): boolean =>
            isStorageError(err) &&
            err.code === "INVALID_KEY" &&
            err.retryable === false &&
            err.providerKind === provider.kind;

          await assert.rejects(() => provider.headObject(invalidKey), assertInvalidKeyError);
          await assert.rejects(() => provider.getObject(invalidKey), assertInvalidKeyError);
          await assert.rejects(() => provider.deleteObject(invalidKey), assertInvalidKeyError);
          await assert.rejects(
            () =>
              provider.putObject({
                key: invalidKey,
                body: Readable.from([Buffer.from("blocked")]),
                metadata: {
                  contentType: "text/plain",
                  contentLength: 7,
                  checksumSha256: sha256Hex(Buffer.from("blocked")),
                },
              }),
            assertInvalidKeyError,
          );
        }
      },
    },

    {
      name: "normalizes NOT_FOUND, CHECKSUM_MISMATCH, and TIMEOUT errors with consistent retryability",
      async run({ provider, keyPrefix }) {
        const missingKey = buildKey(keyPrefix, "versions/1/error-norm-missing");
        try {
          await provider.getObject(missingKey);
          assert.fail("Expected NOT_FOUND error");
        } catch (err) {
          assert.equal(isStorageError(err), true);
          assert.equal((err as StorageError).code, "NOT_FOUND");
          assert.equal((err as StorageError).providerKind, provider.kind);
          assert.equal(isRetryableStorageError(err), false);
        }

        const checksumKey = buildKey(keyPrefix, "versions/1/error-norm-checksum");
        const payload = Buffer.from("checksum-normalization-check");
        try {
          await provider.putObject({
            key: checksumKey,
            body: Readable.from([payload]),
            metadata: {
              contentType: "text/plain",
              contentLength: payload.length,
              checksumSha256: "e".repeat(64),
            },
          });
          assert.fail("Expected CHECKSUM_MISMATCH error");
        } catch (err) {
          assert.equal(isStorageError(err), true);
          assert.equal((err as StorageError).code, "CHECKSUM_MISMATCH");
          assert.equal((err as StorageError).providerKind, provider.kind);
          assert.equal(isRetryableStorageError(err), false);
        }

        const timeoutController = new AbortController();
        timeoutController.abort();
        try {
          await provider.putObject({
            key: buildKey(keyPrefix, "versions/1/error-norm-timeout"),
            body: Readable.from([payload]),
            metadata: {
              contentType: "text/plain",
              contentLength: payload.length,
              checksumSha256: sha256Hex(payload),
            },
            abortSignal: timeoutController.signal,
          });
          assert.fail("Expected TIMEOUT error");
        } catch (err) {
          assert.equal(isStorageError(err), true);
          assert.equal((err as StorageError).code, "TIMEOUT");
          assert.equal((err as StorageError).providerKind, provider.kind);
          assert.equal(isRetryableStorageError(err), true);
        }
      },
    },
  ];
}
