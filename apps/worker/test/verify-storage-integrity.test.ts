import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type {
  AuditEventInput,
  AuditRepositoryPort,
  StorageConnectionEntity,
  StorageConnectionRepositoryPort,
} from "@papyrus/domain";
import { type StorageProvider, createStorageProviderRegistry } from "@papyrus/storage-core";
import { describe, expect, it } from "vitest";
import {
  type StorageIntegrityStorePort,
  type StorageObjectReferenceRecord,
  type UnrecognizedObjectListPort,
  createVerifyStorageIntegrityHandler,
} from "../src/jobs/verify-storage-integrity.js";

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function createIntegrityTestHarness() {
  const orgId = randomUUID();
  const connId = randomUUID();
  const deletedKeys: string[] = [];
  const headCalls: string[] = [];
  const getCalls: string[] = [];
  const auditEvents: AuditEventInput[] = [];
  const storedObjects = new Map<
    string,
    { readonly content: Buffer; readonly contentLength: number }
  >();
  const referencedObjects: StorageObjectReferenceRecord[] = [];

  const connection: StorageConnectionEntity = {
    id: connId,
    organizationId: orgId,
    name: "Local Primary",
    kind: "local",
    isDefault: true,
    status: "ACTIVE",
    nonSecretConfig: { rootDirectory: "/var/lib/papyrus" },
    encryptedSecretRef: null,
    lastHealthCheckAt: null,
    lastHealthMessage: null,
    createdAt: "2026-11-22T09:00:00.000Z",
    updatedAt: "2026-11-22T09:00:00.000Z",
  };

  const provider: StorageProvider = {
    kind: "local",
    capabilities: {
      streamingRead: true,
      streamingWrite: true,
      signedUpload: false,
      signedDownload: false,
      multipartUpload: false,
      serverSideCopy: false,
    },
    async checkHealth() {
      return { healthy: true, message: "ok", checkedAt: new Date() };
    },
    async putObject() {
      throw new Error("putObject not expected in integrity verifier");
    },
    async getObject(key) {
      getCalls.push(key.value);
      const entry = storedObjects.get(key.value);
      if (!entry) {
        throw new Error(`Missing object ${key.value}`);
      }
      return {
        body: Readable.from(entry.content),
        metadata: {
          contentType: "application/pdf",
          contentLength: entry.contentLength,
          checksumSha256: sha256Hex(entry.content),
        },
      };
    },
    async headObject(key) {
      headCalls.push(key.value);
      const entry = storedObjects.get(key.value);
      if (!entry) {
        return null;
      }
      return {
        key,
        contentType: "application/pdf",
        contentLength: entry.contentLength,
        checksumSha256: sha256Hex(entry.content),
      };
    },
    async deleteObject(key) {
      deletedKeys.push(key.value);
      storedObjects.delete(key.value);
    },
  };

  const registry = createStorageProviderRegistry();
  registry.registerFactory("local", async () => provider);

  const store: StorageIntegrityStorePort = {
    async listReferencedObjects(params) {
      const filtered = referencedObjects.filter((item) => {
        if (params.organizationId && item.organizationId !== params.organizationId) {
          return false;
        }
        if (params.storageConnectionId && item.storageConnectionId !== params.storageConnectionId) {
          return false;
        }
        if (params.fileObjectId && item.fileObjectId !== params.fileObjectId) {
          return false;
        }
        return true;
      });
      const startIdx = params.afterFileObjectId
        ? filtered.findIndex((item) => item.fileObjectId === params.afterFileObjectId) + 1
        : 0;
      return filtered.slice(Math.max(0, startIdx), Math.max(0, startIdx) + params.limit);
    },
    async findKnownObjectKeys(params) {
      const known = new Set<string>();
      for (const ref of referencedObjects) {
        if (
          ref.organizationId === params.organizationId &&
          ref.storageConnectionId === params.storageConnectionId &&
          params.objectKeys.includes(ref.objectKey)
        ) {
          known.add(ref.objectKey);
        }
      }
      return known;
    },
  };

  const connections: StorageConnectionRepositoryPort = {
    async create() {
      throw new Error("not used");
    },
    async findById(id) {
      return id === connId ? connection : null;
    },
    async findDefaultByOrganization() {
      return connection;
    },
    async listByOrganization() {
      return [connection];
    },
    async update() {
      throw new Error("not used");
    },
    async setDefault() {
      throw new Error("not used");
    },
    async recordHealthCheck() {},
  };

  const audit: AuditRepositoryPort = {
    async append(input) {
      auditEvents.push(input);
      return {
        ...input,
        id: `audit-${auditEvents.length}`,
        occurredAt: "2026-11-22T09:10:00.000Z",
      };
    },
    async list() {
      return { items: [], total: 0, page: 1, pageSize: 20 };
    },
  };

  const unrecognizedObjectScanner: UnrecognizedObjectListPort = {
    async listObjectKeys() {
      return [...storedObjects.keys()];
    },
  };

  let seq = 1;
  const handler = createVerifyStorageIntegrityHandler({
    store,
    connections,
    storageRegistry: registry,
    audit,
    unrecognizedObjectScanner,
    generateId: () => `req-${seq++}`,
    now: () => new Date("2026-11-22T09:10:00.000Z"),
  });

  return {
    orgId,
    connId,
    storedObjects,
    referencedObjects,
    deletedKeys,
    headCalls,
    getCalls,
    auditEvents,
    handler,
  };
}

describe("verify-storage-integrity worker job", () => {
  it("compares database references via headObject, flags missing and mismatched sizes without reading streams", async () => {
    const harness = createIntegrityTestHarness();

    const validContent = Buffer.from("%PDF-1.7 valid contract payload", "utf8");
    const validKey = `org/${harness.orgId}/documents/doc-1/versions/ver-1/obj-valid`;
    const missingKey = `org/${harness.orgId}/documents/doc-2/versions/ver-1/obj-missing`;
    const wrongSizeKey = `org/${harness.orgId}/documents/doc-3/versions/ver-1/obj-size`;

    harness.storedObjects.set(validKey, {
      content: validContent,
      contentLength: validContent.length,
    });
    harness.storedObjects.set(wrongSizeKey, {
      content: Buffer.from("truncated", "utf8"),
      contentLength: 9,
    });

    harness.referencedObjects.push(
      {
        fileObjectId: "file-1",
        organizationId: harness.orgId,
        storageConnectionId: harness.connId,
        objectKey: validKey,
        checksumSha256: sha256Hex(validContent),
        expectedSizeBytes: validContent.length,
        status: "AVAILABLE",
      },
      {
        fileObjectId: "file-2",
        organizationId: harness.orgId,
        storageConnectionId: harness.connId,
        objectKey: missingKey,
        checksumSha256: "a".repeat(64),
        expectedSizeBytes: 128,
        status: "AVAILABLE",
      },
      {
        fileObjectId: "file-3",
        organizationId: harness.orgId,
        storageConnectionId: harness.connId,
        objectKey: wrongSizeKey,
        checksumSha256: "b".repeat(64),
        expectedSizeBytes: 512,
        status: "AVAILABLE",
      },
    );

    const report = await harness.handler.runIntegrityCheck({
      organizationId: harness.orgId,
      batchSize: 2,
    });

    expect(report.verifyChecksum).toBe(false);
    expect(report.scannedCount).toBe(3);
    expect(report.okCount).toBe(1);
    expect(report.missingObjects.map((item) => item.fileObjectId)).toEqual(["file-2"]);
    expect(report.sizeMismatchObjects.map((item) => item.fileObjectId)).toEqual(["file-3"]);
    expect(harness.headCalls).toEqual([validKey, missingKey, wrongSizeKey]);
    expect(harness.getCalls).toHaveLength(0);
    expect(harness.auditEvents.map((evt) => evt.action)).toEqual([
      "STORAGE_INTEGRITY_ANOMALY_DETECTED",
      "STORAGE_INTEGRITY_ANOMALY_DETECTED",
    ]);
  });

  it("verifies object checksums on demand via streaming without buffering and detects silent bit-rot corruption", async () => {
    const harness = createIntegrityTestHarness();

    const originalContent = Buffer.from("Important immutable PDF content", "utf8");
    const corruptedContent = Buffer.from("Important CORRUPTED PDF content", "utf8");
    expect(corruptedContent.length).toBe(originalContent.length);

    const okKey = `org/${harness.orgId}/documents/doc-ok/versions/ver-1/obj-ok`;
    const corruptKey = `org/${harness.orgId}/documents/doc-bad/versions/ver-1/obj-bad`;

    harness.storedObjects.set(okKey, {
      content: originalContent,
      contentLength: originalContent.length,
    });
    harness.storedObjects.set(corruptKey, {
      content: corruptedContent,
      contentLength: corruptedContent.length,
    });

    harness.referencedObjects.push(
      {
        fileObjectId: "file-ok",
        organizationId: harness.orgId,
        storageConnectionId: harness.connId,
        objectKey: okKey,
        checksumSha256: sha256Hex(originalContent),
        expectedSizeBytes: originalContent.length,
        status: "AVAILABLE",
      },
      {
        fileObjectId: "file-corrupt",
        organizationId: harness.orgId,
        storageConnectionId: harness.connId,
        objectKey: corruptKey,
        checksumSha256: sha256Hex(originalContent),
        expectedSizeBytes: originalContent.length,
        status: "AVAILABLE",
      },
    );

    const okFinding = await harness.handler.verifyObjectChecksumOnDemand("file-ok", "admin-1");
    expect(okFinding).not.toBeNull();
    expect(okFinding?.status).toBe("OK");
    expect(okFinding?.checksumVerified).toBe(true);
    expect(okFinding?.actualChecksumSha256).toBe(sha256Hex(originalContent));

    const corruptFinding = await harness.handler.verifyObjectChecksumOnDemand(
      "file-corrupt",
      "admin-1",
    );
    expect(corruptFinding).not.toBeNull();
    expect(corruptFinding?.status).toBe("CHECKSUM_MISMATCH");
    expect(corruptFinding?.checksumVerified).toBe(true);
    expect(corruptFinding?.actualChecksumSha256).toBe(sha256Hex(corruptedContent));
    expect(corruptFinding?.expectedChecksumSha256).toBe(sha256Hex(originalContent));

    const nonexistent = await harness.handler.verifyObjectChecksumOnDemand("file-does-not-exist");
    expect(nonexistent).toBeNull();
  });

  it("reports unrecognized storage objects for human review and NEVER deletes them automatically", async () => {
    const harness = createIntegrityTestHarness();

    const validContent = Buffer.from("valid", "utf8");
    const validKey = `org/${harness.orgId}/documents/doc-1/versions/ver-1/obj-valid`;
    const unrecognizedKey = `org/${harness.orgId}/orphan/untracked-object-xyz`;

    harness.storedObjects.set(validKey, {
      content: validContent,
      contentLength: validContent.length,
    });
    harness.storedObjects.set(unrecognizedKey, {
      content: Buffer.from("unknown binary", "utf8"),
      contentLength: 14,
    });

    harness.referencedObjects.push({
      fileObjectId: "file-1",
      organizationId: harness.orgId,
      storageConnectionId: harness.connId,
      objectKey: validKey,
      checksumSha256: sha256Hex(validContent),
      expectedSizeBytes: validContent.length,
      status: "AVAILABLE",
    });

    const report = await harness.handler.runIntegrityCheck({
      organizationId: harness.orgId,
      scanUnrecognizedObjects: true,
    });

    expect(report.okCount).toBe(1);
    expect(report.unrecognizedObjects).toEqual([
      {
        organizationId: harness.orgId,
        storageConnectionId: harness.connId,
        objectKey: unrecognizedKey,
      },
    ]);
    // Critical safety invariant: unrecognized objects are NEVER deleted automatically
    expect(harness.deletedKeys).toHaveLength(0);
    expect(harness.storedObjects.has(unrecognizedKey)).toBe(true);
    expect(harness.auditEvents).toHaveLength(1);
    expect(harness.auditEvents[0]?.action).toBe("STORAGE_INTEGRITY_UNRECOGNIZED_DETECTED");
    expect(harness.auditEvents[0]?.metadata).toEqual({
      objectKey: unrecognizedKey,
      automaticallyDeleted: false,
    });
  });
});
