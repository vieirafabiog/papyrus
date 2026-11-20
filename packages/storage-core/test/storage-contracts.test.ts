import { describe, expect, it } from "vitest";
import {
  normalizeStorageError,
  sanitizeStorageErrorMessage,
  StorageError,
} from "../src/index.js";

describe("Storage core contracts and errors", () => {
  it("sanitizes secrets from error messages", () => {
    const raw =
      "Failed connecting to https://admin:super_secret_pass@s3.internal/bucket with AccessKeyId=AKIA12345 and secret=mysecretvalue";
    const sanitized = sanitizeStorageErrorMessage(raw);

    expect(sanitized).not.toContain("super_secret_pass");
    expect(sanitized).not.toContain("AKIA12345");
    expect(sanitized).not.toContain("mysecretvalue");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("normalizes unknown errors into typed StorageError without leaking credentials", () => {
    const notFound = normalizeStorageError(new Error("ENOENT: no such file"), "local");
    expect(notFound).toBeInstanceOf(StorageError);
    expect(notFound.code).toBe("NOT_FOUND");
    expect(notFound.retryable).toBe(false);

    const timeout = normalizeStorageError(new Error("Request ETIMEDOUT"), "s3");
    expect(timeout.code).toBe("TIMEOUT");
    expect(timeout.retryable).toBe(true);
    expect(timeout.providerKind).toBe("s3");
  });
});
