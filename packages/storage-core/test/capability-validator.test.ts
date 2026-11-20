import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  type StorageCapabilities,
  StorageError,
  type StorageProvider,
  type StorageProviderKind,
  assertStorageCapabilities,
  assertStorageCapability,
  hasStorageCapability,
  requireSignedDownloadTargetProvider,
  requireSignedUploadTargetProvider,
  resolveDownloadMode,
  resolveUploadMode,
  validateStorageCapabilities,
} from "../src/index.js";

function buildProvider(
  kind: StorageProviderKind,
  capabilities: StorageCapabilities,
  options: { withSignedUpload?: boolean; withSignedDownload?: boolean } = {},
): StorageProvider {
  const provider: StorageProvider = {
    kind,
    capabilities,
    async checkHealth() {
      return { healthy: true, message: "ok", checkedAt: new Date() };
    },
    async putObject(input) {
      return { key: input.key, ...input.metadata };
    },
    async getObject() {
      return {
        body: Readable.from([]),
        metadata: {
          contentType: "application/octet-stream",
          contentLength: 0,
          checksumSha256: "0".repeat(64),
        },
      };
    },
    async headObject() {
      return null;
    },
    async deleteObject() {
      // No-op test stub.
    },
    ...(options.withSignedUpload
      ? {
          async createSignedUploadTarget() {
            return {
              url: "https://storage.invalid/upload",
              method: "PUT" as const,
              headers: {},
              expiresAt: new Date(Date.now() + 60_000),
            };
          },
        }
      : {}),
    ...(options.withSignedDownload
      ? {
          async createSignedDownloadTarget() {
            return {
              url: "https://storage.invalid/download",
              method: "GET" as const,
              headers: {},
              expiresAt: new Date(Date.now() + 60_000),
            };
          },
        }
      : {}),
  };

  return provider;
}

describe("Storage capability validator", () => {
  it("never assumes signed URL, multipart, or server-side copy support", () => {
    const localProvider = buildProvider("local", {
      streamingRead: true,
      streamingWrite: true,
      signedUpload: false,
      signedDownload: false,
      multipartUpload: false,
      serverSideCopy: false,
    });

    expect(hasStorageCapability(localProvider, "streamingRead")).toBe(true);
    expect(hasStorageCapability(localProvider, "streamingWrite")).toBe(true);
    expect(hasStorageCapability(localProvider, "signedUpload")).toBe(false);
    expect(hasStorageCapability(localProvider, "signedDownload")).toBe(false);
    expect(hasStorageCapability(localProvider, "multipartUpload")).toBe(false);
    expect(hasStorageCapability(localProvider, "serverSideCopy")).toBe(false);

    const validation = validateStorageCapabilities(localProvider, [
      "streamingRead",
      "signedUpload",
      "multipartUpload",
      "serverSideCopy",
      "signedUpload",
    ]);
    expect(validation).toEqual({
      supported: false,
      missing: ["signedUpload", "multipartUpload", "serverSideCopy"],
    });

    expect(() =>
      assertStorageCapabilities(localProvider, ["signedUpload", "serverSideCopy"]),
    ).toThrowError(StorageError);

    try {
      assertStorageCapability(localProvider, "multipartUpload");
      expect.unreachable("Expected StorageError");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      const storageErr = error as StorageError;
      expect(storageErr.code).toBe("CAPABILITY_NOT_SUPPORTED");
      expect(storageErr.providerKind).toBe("local");
    }
  });

  it("rejects signed URL capability when capability flag is true but method is missing", () => {
    const inconsistentProvider = buildProvider(
      "s3",
      {
        streamingRead: true,
        streamingWrite: true,
        signedUpload: true,
        signedDownload: true,
        multipartUpload: true,
        serverSideCopy: true,
      },
      { withSignedUpload: false, withSignedDownload: false },
    );

    expect(hasStorageCapability(inconsistentProvider, "signedUpload")).toBe(false);
    expect(hasStorageCapability(inconsistentProvider, "signedDownload")).toBe(false);
    expect(() => requireSignedUploadTargetProvider(inconsistentProvider)).toThrowError(
      StorageError,
    );
    expect(() => requireSignedDownloadTargetProvider(inconsistentProvider)).toThrowError(
      StorageError,
    );
  });

  it("resolves upload and download modes with safe streaming fallback when signed URLs are unsupported", async () => {
    const localProvider = buildProvider("local", {
      streamingRead: true,
      streamingWrite: true,
      signedUpload: false,
      signedDownload: false,
      multipartUpload: false,
      serverSideCopy: false,
    });

    expect(resolveUploadMode(localProvider, true)).toBe("API_STREAMING");
    expect(resolveDownloadMode(localProvider, true)).toBe("API_STREAMING");

    const s3Provider = buildProvider(
      "s3",
      {
        streamingRead: true,
        streamingWrite: true,
        signedUpload: true,
        signedDownload: true,
        multipartUpload: true,
        serverSideCopy: true,
      },
      { withSignedUpload: true, withSignedDownload: true },
    );

    expect(resolveUploadMode(s3Provider, true)).toBe("SIGNED_UPLOAD");
    expect(resolveUploadMode(s3Provider, false)).toBe("API_STREAMING");
    expect(resolveDownloadMode(s3Provider, true)).toBe("SIGNED_DOWNLOAD");
    expect(resolveDownloadMode(s3Provider, false)).toBe("API_STREAMING");

    const signedUploadProvider = requireSignedUploadTargetProvider(s3Provider);
    const target = await signedUploadProvider.createSignedUploadTarget({
      key: { value: "org/1/documents/2/versions/3/4" },
      contentType: "application/pdf",
      contentLength: 1024,
      expiresInSeconds: 60,
    });
    expect(target.method).toBe("PUT");

    const readOnlyBrokenProvider = buildProvider("s3", {
      streamingRead: false,
      streamingWrite: false,
      signedUpload: false,
      signedDownload: false,
      multipartUpload: false,
      serverSideCopy: false,
    });
    expect(() => resolveUploadMode(readOnlyBrokenProvider, true)).toThrowError(StorageError);
    expect(() => resolveDownloadMode(readOnlyBrokenProvider, true)).toThrowError(StorageError);
  });
});
