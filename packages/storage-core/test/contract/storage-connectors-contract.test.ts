import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  StorageError,
  buildStorageProviderContractScenarios,
  isRetryableStorageError,
  normalizeStorageError,
  sanitizeStorageErrorMessage,
} from "../../src/index.js";
import {
  type ReferenceContractConnectorHandle,
  createReferenceContractConnector,
} from "./connector-contract.harness.js";

describe("Storage connector shared contract suite (capabilities & normalized errors)", () => {
  const scenarios = buildStorageProviderContractScenarios();

  describe("Local connector capability profile (streaming-only)", () => {
    let handle: ReferenceContractConnectorHandle;

    beforeAll(async () => {
      handle = await createReferenceContractConnector({
        kind: "local",
        enableSignedTargets: false,
      });
    });

    afterAll(async () => {
      await handle.close();
    });

    for (const [index, scenario] of scenarios.entries()) {
      it(scenario.name, async () => {
        await scenario.run({
          provider: handle.provider,
          keyPrefix: `org/contract/local/doc-${index + 1}`,
        });
      });
    }
  });

  describe("S3 connector capability profile (streaming + signed targets)", () => {
    let handle: ReferenceContractConnectorHandle;

    beforeAll(async () => {
      handle = await createReferenceContractConnector({
        kind: "s3",
        enableSignedTargets: true,
      });
    });

    afterAll(async () => {
      await handle.close();
    });

    for (const [index, scenario] of scenarios.entries()) {
      it(scenario.name, async () => {
        await scenario.run({
          provider: handle.provider,
          keyPrefix: `org/contract/s3/doc-${index + 1}`,
        });
      });
    }
  });

  it("normalizes provider-specific errors across local and s3 without leaking secrets", () => {
    const cases = [
      {
        providerKind: "local" as const,
        raw: Object.assign(new Error("ENOENT: missing file token=secret123"), { code: "ENOENT" }),
        expectedCode: "NOT_FOUND",
        expectedRetryable: false,
      },
      {
        providerKind: "local" as const,
        raw: Object.assign(new Error("EACCES: permission denied password=abc"), { code: "EACCES" }),
        expectedCode: "UNAUTHORIZED",
        expectedRetryable: false,
      },
      {
        providerKind: "s3" as const,
        raw: Object.assign(new Error("AccessDenied X-Amz-Signature=deadbeef123456"), {
          $metadata: { httpStatusCode: 403 },
        }),
        expectedCode: "UNAUTHORIZED",
        expectedRetryable: false,
      },
      {
        providerKind: "s3" as const,
        raw: Object.assign(new Error("SlowDown rate exceeded"), {
          $metadata: { httpStatusCode: 503 },
        }),
        expectedCode: "THROTTLED",
        expectedRetryable: true,
      },
      {
        providerKind: "s3" as const,
        raw: Object.assign(new Error("Connection refused https://user:topsecret@minio:9000"), {
          code: "ECONNREFUSED",
        }),
        expectedCode: "UNAVAILABLE",
        expectedRetryable: true,
      },
    ];

    for (const testCase of cases) {
      const normalized = normalizeStorageError(testCase.raw, testCase.providerKind);
      expect(normalized).toBeInstanceOf(StorageError);
      expect(normalized.code).toBe(testCase.expectedCode);
      expect(normalized.providerKind).toBe(testCase.providerKind);
      expect(isRetryableStorageError(normalized)).toBe(testCase.expectedRetryable);
      expect(normalized.message).not.toContain("secret123");
      expect(normalized.message).not.toContain("abc");
      expect(normalized.message).not.toContain("deadbeef123456");
      expect(normalized.message).not.toContain("topsecret");
      expect(sanitizeStorageErrorMessage(normalized.message)).toBe(normalized.message);
    }
  });
});
