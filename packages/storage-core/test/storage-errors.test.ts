import { describe, expect, it } from "vitest";
import {
  StorageError,
  isRetryableStorageError,
  isStorageError,
  normalizeStorageError,
  sanitizeStorageErrorMessage,
} from "../src/index.js";

describe("Storage error normalization and redaction", () => {
  it("normalizes not found, unauthorized, timeout, throttling, unavailable, checksum mismatch, and conflict", () => {
    const enoent = normalizeStorageError(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
      "local",
    );
    expect(enoent.code).toBe("NOT_FOUND");
    expect(enoent.retryable).toBe(false);

    const noSuchKey = normalizeStorageError(
      { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } },
      "s3",
    );
    expect(noSuchKey.code).toBe("NOT_FOUND");
    expect(noSuchKey.providerKind).toBe("s3");

    const accessDenied = normalizeStorageError(
      new Error("AccessDenied with accessKeyId=AKIA_SHOULD_HIDE"),
      "s3",
    );
    expect(accessDenied.code).toBe("UNAUTHORIZED");
    expect(accessDenied.retryable).toBe(false);
    expect(accessDenied.message).not.toContain("AKIA_SHOULD_HIDE");

    const http401 = normalizeStorageError({ $metadata: { httpStatusCode: 401 } }, "s3");
    expect(http401.code).toBe("UNAUTHORIZED");

    const abortErr = normalizeStorageError(
      Object.assign(new Error("signal"), { name: "AbortError" }),
      "s3",
    );
    expect(abortErr.code).toBe("TIMEOUT");
    expect(abortErr.retryable).toBe(true);

    const throttled = normalizeStorageError(
      { name: "SlowDown", $metadata: { httpStatusCode: 429 } },
      "s3",
    );
    expect(throttled.code).toBe("THROTTLED");
    expect(throttled.retryable).toBe(true);

    const unavailable = normalizeStorageError(
      Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
      "s3",
    );
    expect(unavailable.code).toBe("UNAVAILABLE");
    expect(unavailable.retryable).toBe(true);

    const serviceUnavailable = normalizeStorageError({ $metadata: { httpStatusCode: 503 } }, "s3");
    expect(serviceUnavailable.code).toBe("UNAVAILABLE");
    expect(serviceUnavailable.retryable).toBe(true);

    const checksum = normalizeStorageError(
      new Error("BadDigest: calculated SHA-256 mismatch"),
      "local",
    );
    expect(checksum.code).toBe("CHECKSUM_MISMATCH");
    expect(checksum.retryable).toBe(false);

    const conflict = normalizeStorageError(
      Object.assign(new Error("destination conflict"), { code: "EEXIST" }),
      "local",
    );
    expect(conflict.code).toBe("CONFLICT");
    expect(conflict.retryable).toBe(false);

    const precondition = normalizeStorageError(
      { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } },
      "s3",
    );
    expect(precondition.code).toBe("CONFLICT");
  });

  it("extracts cause errors, preserves StorageError, and exposes type/retry guards", () => {
    const wrapped = new Error("Wrapper failure", {
      cause: Object.assign(new Error("no space"), { code: "ENOSPC" }),
    });
    const normalized = normalizeStorageError(wrapped, "local");
    expect(isStorageError(normalized)).toBe(true);
    expect(normalized.code).toBe("UNAVAILABLE");
    expect(isRetryableStorageError(normalized)).toBe(true);

    const withoutKind = new StorageError("CONFLICT", "Objeto já existe");
    const withKind = normalizeStorageError(withoutKind, "local");
    expect(withKind.code).toBe("CONFLICT");
    expect(withKind.providerKind).toBe("local");
    expect(isRetryableStorageError(withKind)).toBe(false);
  });

  it("never leaks URL credentials, Bearer tokens, AWS keys, or JSON secrets on UNKNOWN errors", () => {
    const raw =
      'Endpoint https://minio:superpass123@s3.local/bucket?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA999 failed Authorization: Bearer secret-jwt-token {"secretAccessKey":"dontleakme"}';
    const sanitized = sanitizeStorageErrorMessage(raw);
    expect(sanitized).not.toContain("superpass123");
    expect(sanitized).not.toContain("deadbeef");
    expect(sanitized).not.toContain("AKIA999");
    expect(sanitized).not.toContain("secret-jwt-token");
    expect(sanitized).not.toContain("dontleakme");

    const unknownErr = normalizeStorageError(new Error(raw), "s3");
    expect(unknownErr.code).toBe("UNKNOWN");
    expect(unknownErr.message).not.toContain("superpass123");
    expect(unknownErr.message).not.toContain("deadbeef");
    expect(unknownErr.message).not.toContain("AKIA999");
    expect(unknownErr.message).not.toContain("secret-jwt-token");
    expect(unknownErr.message).not.toContain("dontleakme");
  });
});
