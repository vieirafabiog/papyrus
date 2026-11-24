import { StorageError } from "@papyrus/storage-core";
import { describe, expect, it } from "vitest";
import {
  isRestrictedIpAddress,
  parseS3StorageConfig,
  sanitizeS3ConfigSummary,
  validateS3EndpointResolution,
} from "../src/index.js";

const BASE_VALID_CONFIG = {
  endpoint: "https://s3.us-east-1.amazonaws.com",
  region: "us-east-1",
  bucket: "papyrus-corp-docs",
  forcePathStyle: false,
  credentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
};

describe("S3 configuration schema and SSRF security validation", () => {
  it("parses valid HTTPS S3 config with defaults and strips secrets from sanitized summary", () => {
    const parsed = parseS3StorageConfig(BASE_VALID_CONFIG);

    expect(parsed.endpoint).toBe("https://s3.us-east-1.amazonaws.com");
    expect(parsed.region).toBe("us-east-1");
    expect(parsed.bucket).toBe("papyrus-corp-docs");
    expect(parsed.forcePathStyle).toBe(false);
    expect(parsed.tls.rejectUnauthorized).toBe(true);
    expect(parsed.tls.allowInsecureHttp).toBe(false);
    expect(parsed.timeouts).toEqual({
      connectionTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
    });

    const summary = JSON.stringify(sanitizeS3ConfigSummary(parsed));
    expect(summary).not.toContain(BASE_VALID_CONFIG.credentials.accessKeyId);
    expect(summary).not.toContain(BASE_VALID_CONFIG.credentials.secretAccessKey);
    expect(summary).toContain('"hasCredentials":true');
  });

  it("blocks insecure HTTP by default, embedded URL credentials, localhost, private IPs, and cloud metadata endpoints", () => {
    const blockedEndpoints = [
      "http://s3.us-east-1.amazonaws.com",
      "https://user:pass@s3.us-east-1.amazonaws.com",
      "https://s3.us-east-1.amazonaws.com?foo=bar",
      "https://127.0.0.1:9000",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5:9000",
      "https://172.16.0.10:9000",
      "https://192.168.1.20:9000",
      "https://[::1]:9000",
      "https://[::ffff:127.0.0.1]:9000",
      "https://localhost:9000",
      "https://minio.internal:9000",
      "https://metadata.google.internal",
      "https://minio:9000",
    ];

    for (const endpoint of blockedEndpoints) {
      expect(() => parseS3StorageConfig({ ...BASE_VALID_CONFIG, endpoint })).toThrowError(
        StorageError,
      );
    }

    expect(isRestrictedIpAddress("127.0.0.1")).toBe(true);
    expect(isRestrictedIpAddress("100.64.0.1")).toBe(true);
    expect(isRestrictedIpAddress("8.8.8.8")).toBe(false);
  });

  it("allows controlled private MinIO endpoint only when explicitly enabled, while still blocking metadata IPs", () => {
    const minioConfig = parseS3StorageConfig(
      {
        ...BASE_VALID_CONFIG,
        endpoint: "http://127.0.0.1:9000",
        forcePathStyle: true,
        tls: { allowInsecureHttp: true, rejectUnauthorized: false },
        timeouts: { connectionTimeoutMs: 2_000, requestTimeoutMs: 10_000 },
      },
      { allowPrivateEndpoints: true },
    );

    expect(minioConfig.forcePathStyle).toBe(true);
    expect(minioConfig.tls.allowInsecureHttp).toBe(true);

    // Even with allowPrivateEndpoints: true, cloud metadata endpoints remain blocked!
    expect(() =>
      parseS3StorageConfig(
        {
          ...BASE_VALID_CONFIG,
          endpoint: "http://169.254.169.254",
          tls: { allowInsecureHttp: true },
        },
        { allowPrivateEndpoints: true },
      ),
    ).toThrowError(StorageError);
  });

  it("blocks DNS resolution that points to loopback, private, or metadata IPs (DNS rebinding defense)", async () => {
    await expect(
      validateS3EndpointResolution("https://evil-rebind.example.com", {}, async () => [
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      validateS3EndpointResolution(
        "https://evil-meta.example.com",
        { allowPrivateEndpoints: true },
        async () => [{ address: "169.254.169.254", family: 4 }],
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      validateS3EndpointResolution("https://s3.valid.example.com", {}, async () => [
        { address: "52.216.10.20", family: 4 },
      ]),
    ).resolves.toBeUndefined();
  });

  it("validates bucket naming, region format, credentials, and timeouts strictly", () => {
    expect(() =>
      parseS3StorageConfig({ ...BASE_VALID_CONFIG, bucket: "Invalid_Bucket" }),
    ).toThrowError(StorageError);
    expect(() =>
      parseS3StorageConfig({ ...BASE_VALID_CONFIG, bucket: "192.168.0.1" }),
    ).toThrowError(StorageError);
    expect(() =>
      parseS3StorageConfig({ ...BASE_VALID_CONFIG, region: "Invalid Region!" }),
    ).toThrowError(StorageError);
    expect(() =>
      parseS3StorageConfig({
        ...BASE_VALID_CONFIG,
        credentials: { accessKeyId: "ab", secretAccessKey: "short" },
      }),
    ).toThrowError(StorageError);
    expect(() =>
      parseS3StorageConfig({
        ...BASE_VALID_CONFIG,
        timeouts: { connectionTimeoutMs: 50, requestTimeoutMs: 100 },
      }),
    ).toThrowError(StorageError);
  });
});
