import { describe, expect, it } from "vitest";
import {
  type AuditEventInput,
  type AuditEventRecord,
  type AuditRepositoryPort,
  DomainError,
  MAX_AUDIT_METADATA_KEYS,
  MAX_AUDIT_METADATA_STRING_LENGTH,
  type TransactionContext,
  type TransactionManagerPort,
  createAuditWriter,
  redactSensitiveAuditString,
  sanitizeAuditMetadata,
} from "../src/index.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const DOC_ID = "33333333-3333-4333-8333-333333333333";
const REQ_ID = "44444444-4444-4444-8444-444444444444";

describe("Central AuditWriter", () => {
  it("appends minimal audit events inside the provided business transaction", async () => {
    const captured: Array<{ readonly event: AuditEventInput; readonly tx?: TransactionContext }> =
      [];

    const repository: AuditRepositoryPort = {
      async append(event, tx) {
        captured.push({ event, ...(tx ? { tx } : {}) });
        return {
          ...event,
          id: "audit-1",
          occurredAt: "2026-11-21T18:00:00.000Z",
        };
      },
      async list() {
        return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
      },
    };

    const txMarker: TransactionContext = { __brand: "TransactionContext" };
    const writer = createAuditWriter({ repository });

    const written: AuditEventRecord = await writer.write(
      {
        organizationId: ORG_ID,
        actorUserId: USER_ID,
        action: "DOCUMENT_VERSION_APPROVED",
        resourceType: "DOCUMENT",
        resourceId: DOC_ID,
        result: "SUCCESS",
        requestId: REQ_ID,
        ipAddress: "203.0.113.10",
        metadata: {
          versionNumber: 2,
          taskStatus: "APPROVED",
        },
      },
      txMarker,
    );

    expect(written.id).toBe("audit-1");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.tx).toBe(txMarker);
    expect(captured[0]?.event.ipAddress).toBe("203.0.113.10");
    expect(captured[0]?.event.metadata).toEqual({
      versionNumber: 2,
      taskStatus: "APPROVED",
    });
  });

  it("uses TransactionManager when writeAtomic is invoked without an outer tx", async () => {
    const seenTx: Array<TransactionContext | undefined> = [];
    const atomicTx: TransactionContext = { __brand: "TransactionContext" };

    const repository: AuditRepositoryPort = {
      async append(event, tx) {
        seenTx.push(tx);
        return { ...event, id: "audit-2", occurredAt: "2026-11-21T18:01:00.000Z" };
      },
      async list() {
        return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
      },
    };

    const transactions: TransactionManagerPort = {
      async runInTransaction(fn) {
        return fn(atomicTx);
      },
    };

    const writer = createAuditWriter({ repository, transactions });
    await writer.writeAtomic({
      organizationId: ORG_ID,
      actorUserId: null,
      action: "AUTH_LOGIN_FAILED",
      resourceType: "SESSION",
      resourceId: null,
      result: "DENIED",
      requestId: REQ_ID,
    });

    expect(seenTx).toEqual([atomicTx]);
  });

  it("redacts secrets, signed URLs, binary payloads, and bounds excessive metadata", () => {
    const rawSignedUrl =
      "https://storage.local/bucket/obj?X-Amz-Signature=deadbeef12345&token=secret-jwt";
    expect(redactSensitiveAuditString(rawSignedUrl)).not.toContain("deadbeef12345");
    expect(redactSensitiveAuditString(rawSignedUrl)).not.toContain("secret-jwt");

    expect(
      redactSensitiveAuditString("postgresql://papyrus:MyDbPass99@db.local:5432/papyrus"),
    ).toBe("postgresql://papyrus:[REDACTED]@db.local:5432/papyrus");

    expect(redactSensitiveAuditString("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer [REDACTED]",
    );

    const binaryChunk = new Uint8Array([1, 2, 3, 4]);
    const sanitized = sanitizeAuditMetadata({
      passwordHash: "$argon2id$secret",
      signedUrl: rawSignedUrl,
      encryptedCredentialsRef: "dfsmtp:v1:k1:iv:tag:cipher",
      fileBinary: binaryChunk,
      rawFileBuffer: binaryChunk,
      nestedDocumentBody: { huge: "content" },
      extraDetails: { nested: "value" },
      note: "A".repeat(400),
      validFlag: true,
    });

    expect(sanitized.passwordHash).toBe("[REDACTED]");
    expect(sanitized.signedUrl).toBe("[REDACTED]");
    expect(sanitized.encryptedCredentialsRef).toBe("[REDACTED]");
    expect(sanitized.fileBinary).toBe("[REDACTED]");
    expect(sanitized.rawFileBuffer).toBe("[REDACTED_BINARY]");
    expect(sanitized.nestedDocumentBody).toBe("[REDACTED]");
    expect(sanitized.extraDetails).toBe("[REDACTED_OBJECT]");
    expect(String(sanitized.note).length).toBeLessThanOrEqual(MAX_AUDIT_METADATA_STRING_LENGTH);
    expect(sanitized.validFlag).toBe(true);

    const manyKeys: Record<string, string> = {};
    for (let i = 1; i <= 30; i += 1) {
      manyKeys[`field_${i}`] = `val_${i}`;
    }
    const bounded = sanitizeAuditMetadata(manyKeys);
    expect(bounded._metadataTruncated).toBe(true);
    expect(Object.keys(bounded).length).toBe(MAX_AUDIT_METADATA_KEYS + 1);
  });

  it("rejects empty mandatory audit identifiers", async () => {
    const writer = createAuditWriter({
      repository: {
        async append(event) {
          return { ...event, id: "id", occurredAt: "2026-11-21T18:00:00.000Z" };
        },
        async list() {
          return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
        },
      },
    });

    await expect(
      writer.write({
        organizationId: ORG_ID,
        actorUserId: USER_ID,
        action: "   ",
        resourceType: "DOCUMENT",
        resourceId: DOC_ID,
        result: "SUCCESS",
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
