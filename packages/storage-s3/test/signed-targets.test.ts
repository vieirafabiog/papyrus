import {
  StorageError,
  hasStorageCapability,
  requireSignedDownloadTargetProvider,
  requireSignedUploadTargetProvider,
} from "@docuflow/storage-core";
import { describe, expect, it } from "vitest";
import { createS3StorageProvider, sanitizeDownloadFilename } from "../src/index.js";

const VALID_S3_CONFIG = {
  endpoint: "https://s3.us-east-1.amazonaws.com",
  region: "us-east-1",
  bucket: "docuflow-signed-bucket",
  forcePathStyle: true,
  keyPrefix: "tenant-alpha",
  credentials: {
    accessKeyId: "AKIAEXAMPLEKEY12345",
    secretAccessKey: "VerySecretS3AccessKeyDoNotExpose2026!",
  },
};

describe("S3 optional signed upload/download targets", () => {
  it("disables signed capabilities when enableSignedTargets is omitted or false", () => {
    const provider = createS3StorageProvider(VALID_S3_CONFIG);

    expect(hasStorageCapability(provider, "signedUpload")).toBe(false);
    expect(hasStorageCapability(provider, "signedDownload")).toBe(false);
    expect(provider.createSignedUploadTarget).toBeUndefined();
    expect(provider.createSignedDownloadTarget).toBeUndefined();
    expect(() => requireSignedUploadTargetProvider(provider)).toThrowError(StorageError);
    expect(() => requireSignedDownloadTargetProvider(provider)).toThrowError(StorageError);
  });

  it("generates short-lived single-key single-method SigV4 URLs without exposing secret keys", async () => {
    const fixedNow = new Date("2026-11-20T17:00:00.000Z");
    const provider = createS3StorageProvider(VALID_S3_CONFIG, {
      enableSignedTargets: true,
      signedTargetsOptions: {
        now: () => fixedNow,
        maxUploadBytes: 10 * 1024 * 1024,
      },
    });

    const uploadCapable = requireSignedUploadTargetProvider(provider);
    const downloadCapable = requireSignedDownloadTargetProvider(provider);

    const key = { value: "org/1/documents/2/versions/1/obj-99" };

    const uploadTarget = await uploadCapable.createSignedUploadTarget({
      key,
      contentType: "application/pdf",
      contentLength: 4096,
      expiresInSeconds: 120,
    });

    expect(uploadTarget.method).toBe("PUT");
    expect(uploadTarget.headers).toEqual({
      "content-type": "application/pdf",
      "content-length": "4096",
    });
    expect(uploadTarget.expiresAt.toISOString()).toBe("2026-11-20T17:02:00.000Z");

    const uploadUrl = new URL(uploadTarget.url);
    expect(uploadUrl.pathname).toContain(
      "/docuflow-signed-bucket/tenant-alpha/org/1/documents/2/versions/1/obj-99",
    );
    expect(uploadUrl.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(uploadUrl.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(uploadUrl.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
    expect(uploadUrl.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    expect(uploadTarget.url).not.toContain(VALID_S3_CONFIG.credentials.secretAccessKey);

    const downloadTarget = await downloadCapable.createSignedDownloadTarget({
      key,
      expiresInSeconds: 60,
      downloadName: '../../Contrato\r\n"Final";2026.pdf',
    });

    expect(downloadTarget.method).toBe("GET");
    expect(downloadTarget.headers).toEqual({});
    expect(downloadTarget.expiresAt.toISOString()).toBe("2026-11-20T17:01:00.000Z");
    const downloadUrl = new URL(downloadTarget.url);
    expect(downloadUrl.searchParams.get("response-cache-control")).toBe("private, no-store");
    expect(downloadUrl.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="ContratoFinal2026.pdf"',
    );
    expect(downloadTarget.url).not.toContain(VALID_S3_CONFIG.credentials.secretAccessKey);
  });

  it("rejects out-of-range expirations, invalid keys, oversized uploads, and sanitizes filenames", async () => {
    const provider = createS3StorageProvider(VALID_S3_CONFIG, {
      enableSignedTargets: true,
      signedTargetsOptions: {
        maxUploadBytes: 1024,
      },
    });
    const uploadCapable = requireSignedUploadTargetProvider(provider);
    const downloadCapable = requireSignedDownloadTargetProvider(provider);

    // Too short or too long expiration
    await expect(
      uploadCapable.createSignedUploadTarget({
        key: { value: "org/1/documents/1/versions/1/a" },
        contentType: "application/pdf",
        contentLength: 100,
        expiresInSeconds: 5,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", providerKind: "s3" });

    await expect(
      downloadCapable.createSignedDownloadTarget({
        key: { value: "org/1/documents/1/versions/1/a" },
        expiresInSeconds: 3600,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", providerKind: "s3" });

    // Oversized upload declaration blocked
    await expect(
      uploadCapable.createSignedUploadTarget({
        key: { value: "org/1/documents/1/versions/1/a" },
        contentType: "application/pdf",
        contentLength: 2048,
        expiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Path traversal or arbitrary wildcard key blocked
    await expect(
      downloadCapable.createSignedDownloadTarget({
        key: { value: "../etc/passwd" },
        expiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "INVALID_KEY" });

    await expect(
      uploadCapable.createSignedUploadTarget({
        key: { value: "org/1/*" },
        contentType: "application/pdf",
        contentLength: 100,
        expiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "INVALID_KEY" });

    expect(sanitizeDownloadFilename("/evil/path/../../\r\n")).toBe("documento");
  });
});
