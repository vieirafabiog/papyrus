import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type {
  AuditEventInput,
  AuditRepositoryPort,
  FileObjectEntity,
  StorageConnectionEntity,
  StorageConnectionRepositoryPort,
  TransactionContext,
  TransactionManagerPort,
  UploadSessionEntity,
} from "@docuflow/domain";
import {
  type StorageProvider,
  type StorageProviderKind,
  createStorageProviderRegistry,
} from "@docuflow/storage-core";
import { describe, expect, it } from "vitest";
import {
  type AbandonedUploadCleanupStorePort,
  type CleanupDeletionTarget,
  createCleanupAbandonedUploadsHandler,
} from "../src/jobs/cleanup-uploads.js";

interface StorageOperationState {
  id: string;
  organizationId: string;
  uploadSessionId: string | null;
  fileObjectId: string;
  storageConnectionId: string;
  objectKey: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  completedAt: Date | null;
}

function createCleanupTestHarness(initialNowIso = "2026-11-21T12:00:00.000Z") {
  let clockMs = Date.parse(initialNowIso);
  let seq = 1;

  const sessions = new Map<string, UploadSessionEntity>();
  const fileObjects = new Map<string, FileObjectEntity>();
  const connections = new Map<string, StorageConnectionEntity>();
  const operations = new Map<string, StorageOperationState>();
  const storedBinaries = new Map<string, Buffer>();
  const referencedFileObjects = new Set<string>();
  const failDeleteKeys = new Set<string>();
  const auditEvents: AuditEventInput[] = [];

  const mockProvider: StorageProvider = {
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
      return { healthy: true, message: "ok", checkedAt: new Date(clockMs) };
    },
    async putObject(input) {
      storedBinaries.set(input.key.value, Buffer.from("temp-data"));
      return {
        key: input.key,
        contentType: input.metadata.contentType,
        contentLength: input.metadata.contentLength,
        checksumSha256: input.metadata.checksumSha256,
      };
    },
    async getObject(key) {
      return {
        body: Readable.from([storedBinaries.get(key.value) ?? Buffer.alloc(0)]),
        metadata: {
          contentType: "application/pdf",
          contentLength: 0,
          checksumSha256: "0".repeat(64),
        },
      };
    },
    async headObject() {
      return null;
    },
    async deleteObject(key) {
      if (failDeleteKeys.has(key.value)) {
        throw new Error(`Storage delete failed (Bearer super-secret-token) for ${key.value}`);
      }
      storedBinaries.delete(key.value);
    },
  };

  const storageRegistry = createStorageProviderRegistry();
  storageRegistry.registerFactory("local", () => mockProvider);

  const connectionRepo: StorageConnectionRepositoryPort = {
    async findById(id) {
      return connections.get(id) ?? null;
    },
    async findByName() {
      return null;
    },
    async listByOrganization() {
      return Array.from(connections.values());
    },
    async findDefaultByOrganization() {
      return null;
    },
    async create() {
      throw new Error("Not used");
    },
    async update() {
      return null;
    },
    async setDefault() {
      throw new Error("Not used");
    },
    async updateHealth() {
      return null;
    },
    async hasLinkedFileObjects() {
      return false;
    },
  };

  const store: AbandonedUploadCleanupStorePort = {
    async expireIncompleteSessions(cutoffAt, limit) {
      const expired: {
        sessionId: string;
        organizationId: string;
        fileObjectId: string;
        previousStatus: "PENDING" | "UPLOADED";
      }[] = [];

      for (const session of sessions.values()) {
        if (expired.length >= limit) break;
        if (
          (session.status === "PENDING" || session.status === "UPLOADED") &&
          Date.parse(session.expiresAt) <= cutoffAt.getTime()
        ) {
          const prev = session.status;
          sessions.set(session.id, {
            ...session,
            status: "EXPIRED",
            updatedAt: cutoffAt.toISOString(),
          });
          expired.push({
            sessionId: session.id,
            organizationId: session.organizationId,
            fileObjectId: session.fileObjectId,
            previousStatus: prev,
          });
        }
      }
      return expired;
    },

    async claimAbandonedTempObjects({ abandonedBefore, limit, maxAttempts }) {
      const claimed: CleanupDeletionTarget[] = [];
      for (const session of sessions.values()) {
        if (claimed.length >= limit) break;
        if (
          session.status !== "EXPIRED" &&
          session.status !== "CANCELLED" &&
          session.status !== "FAILED"
        ) {
          continue;
        }
        const referenceTimestampMs =
          session.status === "EXPIRED"
            ? Date.parse(session.expiresAt)
            : Date.parse(session.updatedAt);
        if (referenceTimestampMs > abandonedBefore.getTime()) {
          continue;
        }
        const fileObj = fileObjects.get(session.fileObjectId);
        if (!fileObj || fileObj.status !== "UPLOADING" || referencedFileObjects.has(fileObj.id)) {
          continue;
        }

        fileObjects.set(fileObj.id, { ...fileObj, status: "DELETE_PENDING" });
        const opId = `op-${seq++}`;
        const op: StorageOperationState = {
          id: opId,
          organizationId: session.organizationId,
          uploadSessionId: session.id,
          fileObjectId: fileObj.id,
          storageConnectionId: fileObj.storageConnectionId,
          objectKey: fileObj.objectKey,
          status: "IN_PROGRESS",
          attempts: 1,
          maxAttempts,
          lastError: null,
          nextAttemptAt: null,
          completedAt: null,
        };
        operations.set(opId, op);
        claimed.push({
          operationId: op.id,
          organizationId: op.organizationId,
          uploadSessionId: op.uploadSessionId,
          fileObjectId: op.fileObjectId,
          storageConnectionId: op.storageConnectionId,
          objectKey: op.objectKey,
          attempts: op.attempts,
          maxAttempts: op.maxAttempts,
        });
      }
      return claimed;
    },

    async claimPendingDeletionsForReconciliation({ now, limit }) {
      const claimed: CleanupDeletionTarget[] = [];
      for (const op of operations.values()) {
        if (claimed.length >= limit) break;
        if (op.status !== "PENDING" || op.attempts >= op.maxAttempts) continue;
        if (op.nextAttemptAt && op.nextAttemptAt.getTime() > now.getTime()) continue;

        const fileObj = fileObjects.get(op.fileObjectId);
        if (!fileObj || fileObj.status !== "DELETE_PENDING") continue;

        op.status = "IN_PROGRESS";
        op.attempts += 1;
        claimed.push({
          operationId: op.id,
          organizationId: op.organizationId,
          uploadSessionId: op.uploadSessionId,
          fileObjectId: op.fileObjectId,
          storageConnectionId: op.storageConnectionId,
          objectKey: op.objectKey,
          attempts: op.attempts,
          maxAttempts: op.maxAttempts,
        });
      }
      return claimed;
    },

    async markDeletionCompleted({ operationId, fileObjectId, completedAt }) {
      const op = operations.get(operationId);
      if (op) {
        op.status = "COMPLETED";
        op.completedAt = completedAt;
        op.lastError = null;
      }
      const fileObj = fileObjects.get(fileObjectId);
      if (fileObj) {
        fileObjects.set(fileObjectId, { ...fileObj, status: "MISSING" });
      }
    },

    async recordDeletionFailure({ operationId, attempts, maxAttempts, lastError, nextAttemptAt }) {
      const op = operations.get(operationId);
      if (!op) {
        return "FAILED";
      }
      const exhausted = attempts >= maxAttempts;
      op.status = exhausted ? "FAILED" : "PENDING";
      op.lastError = lastError;
      op.nextAttemptAt = nextAttemptAt;
      return exhausted ? "FAILED" : "PENDING_RETRY";
    },
  };

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      const tx: TransactionContext = { __brand: "TransactionContext" };
      return fn(tx);
    },
  };

  const audit: AuditRepositoryPort = {
    async append(input) {
      auditEvents.push(input);
      return {
        ...input,
        id: `audit-${auditEvents.length}`,
        occurredAt: new Date(clockMs).toISOString(),
      };
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  const handler = createCleanupAbandonedUploadsHandler({
    store,
    connections: connectionRepo,
    storageRegistry,
    transactions,
    audit,
    generateId: () => randomUUID(),
    safetyWindowMs: 30 * 60 * 1000,
    maxDeleteAttempts: 2,
    baseRetryDelayMs: 60_000,
    now: () => new Date(clockMs),
  });

  const addConnection = (id: string, orgId: string, kind: StorageProviderKind = "local") => {
    connections.set(id, {
      id,
      organizationId: orgId,
      name: "Local Store",
      kind,
      isDefault: true,
      status: "ACTIVE",
      nonSecretConfig: { rootDirectory: "/tmp/mock" },
      encryptedSecretRef: null,
      lastHealthCheckAt: null,
      lastHealthMessage: null,
      createdAt: new Date(clockMs).toISOString(),
      updatedAt: new Date(clockMs).toISOString(),
    });
  };

  const addUploadCase = (params: {
    sessionId: string;
    fileObjectId: string;
    orgId: string;
    connId: string;
    sessionStatus: UploadSessionEntity["status"];
    fileStatus: FileObjectEntity["status"];
    expiresAtIso: string;
    updatedAtIso?: string;
    putBinary?: boolean;
  }) => {
    const objectKey = `org/${params.orgId}/documents/doc/versions/v/${params.fileObjectId}`;
    fileObjects.set(params.fileObjectId, {
      id: params.fileObjectId,
      storageConnectionId: params.connId,
      objectKey,
      originalFileName: "temp.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: "a".repeat(64),
      status: params.fileStatus,
      createdAt: params.expiresAtIso,
    });
    sessions.set(params.sessionId, {
      id: params.sessionId,
      organizationId: params.orgId,
      userId: "user-1",
      storageConnectionId: params.connId,
      fileObjectId: params.fileObjectId,
      declaredSizeBytes: 1024,
      declaredContentType: "application/pdf",
      idempotencyKey: `idem-${params.sessionId}`,
      status: params.sessionStatus,
      expiresAt: params.expiresAtIso,
      finalizedAt: null,
      createdAt: params.expiresAtIso,
      updatedAt: params.updatedAtIso ?? params.expiresAtIso,
    });
    if (params.putBinary !== false) {
      storedBinaries.set(objectKey, Buffer.from("abandoned-bytes"));
    }
    return objectKey;
  };

  return {
    advanceMs: (deltaMs: number) => {
      clockMs += deltaMs;
    },
    addConnection,
    addUploadCase,
    sessions,
    fileObjects,
    operations,
    storedBinaries,
    referencedFileObjects,
    failDeleteKeys,
    auditEvents,
    handler,
  };
}

describe("Abandoned uploads cleanup job", () => {
  it("expires incomplete PENDING/UPLOADED sessions immediately but waits for safety window before purging temporary binaries", async () => {
    const h = createCleanupTestHarness("2026-11-21T12:00:00.000Z");
    h.addConnection("conn-1", "org-1");

    // A) Expired 5 minutes ago (inside 30-min safety window) -> must expire session ONLY, keep binary for now
    const keyRecent = h.addUploadCase({
      sessionId: "sess-recent",
      fileObjectId: "file-recent",
      orgId: "org-1",
      connId: "conn-1",
      sessionStatus: "PENDING",
      fileStatus: "UPLOADING",
      expiresAtIso: "2026-11-21T11:55:00.000Z",
    });

    // B) Expired 45 minutes ago (UPLOADED but never finalized, outside 30-min safety window) -> expire + purge binary!
    const keyOld = h.addUploadCase({
      sessionId: "sess-old",
      fileObjectId: "file-old",
      orgId: "org-1",
      connId: "conn-1",
      sessionStatus: "UPLOADED",
      fileStatus: "UPLOADING",
      expiresAtIso: "2026-11-21T11:15:00.000Z",
    });

    // C) Quarantined file (already finalized) -> NEVER deleted by abandoned upload cleaner!
    const keyQuarantined = h.addUploadCase({
      sessionId: "sess-quarantined",
      fileObjectId: "file-quarantined",
      orgId: "org-1",
      connId: "conn-1",
      sessionStatus: "FINALIZED",
      fileStatus: "QUARANTINED",
      expiresAtIso: "2026-11-21T10:00:00.000Z",
    });

    const firstReport = await h.handler.runCleanupCycle();
    expect(firstReport.expiredSessionIds).toEqual(["sess-recent", "sess-old"]);
    expect(firstReport.purgedFileObjectIds).toEqual(["file-old"]);
    expect(h.sessions.get("sess-recent")?.status).toBe("EXPIRED");
    expect(h.fileObjects.get("file-recent")?.status).toBe("UPLOADING");
    expect(h.storedBinaries.has(keyRecent)).toBe(true);

    expect(h.storedBinaries.has(keyOld)).toBe(false);
    expect(h.fileObjects.get("file-old")?.status).toBe("MISSING");
    expect(h.storedBinaries.has(keyQuarantined)).toBe(true);
    expect(h.fileObjects.get("file-quarantined")?.status).toBe("QUARANTINED");

    // Advance 31 minutes so sess-recent passes safety window -> now gets purged!
    h.advanceMs(31 * 60 * 1000);
    const secondReport = await h.handler.runCleanupCycle();
    expect(secondReport.purgedFileObjectIds).toEqual(["file-recent"]);
    expect(h.storedBinaries.has(keyRecent)).toBe(false);
    expect(h.fileObjects.get("file-recent")?.status).toBe("MISSING");
  });

  it("marks DELETE_PENDING and records sanitized storage operation failures for idempotent reconciliation retry and terminal FAILED state", async () => {
    const h = createCleanupTestHarness("2026-11-21T12:00:00.000Z");
    h.addConnection("conn-1", "org-1");

    const keyFailThenRecover = h.addUploadCase({
      sessionId: "sess-fail-recover",
      fileObjectId: "file-fail-recover",
      orgId: "org-1",
      connId: "conn-1",
      sessionStatus: "EXPIRED",
      fileStatus: "UPLOADING",
      expiresAtIso: "2026-11-21T10:00:00.000Z",
    });
    const keyPermanentFail = h.addUploadCase({
      sessionId: "sess-perm-fail",
      fileObjectId: "file-perm-fail",
      orgId: "org-1",
      connId: "conn-1",
      sessionStatus: "CANCELLED",
      fileStatus: "UPLOADING",
      expiresAtIso: "2026-11-21T10:00:00.000Z",
    });

    h.failDeleteKeys.add(keyFailThenRecover);
    h.failDeleteKeys.add(keyPermanentFail);

    // Cycle 1: deletes fail -> BOTH marked DELETE_PENDING, storage operations deferred (PENDING for retry) with sanitized errors
    const cycle1 = await h.handler.runCleanupCycle();
    expect(cycle1.purgedFileObjectIds).toEqual([]);
    expect(cycle1.deferredReconciliationIds).toHaveLength(2);
    expect(h.fileObjects.get("file-fail-recover")?.status).toBe("DELETE_PENDING");
    expect(h.fileObjects.get("file-perm-fail")?.status).toBe("DELETE_PENDING");

    const op1 = Array.from(h.operations.values()).find(
      (o) => o.fileObjectId === "file-fail-recover",
    );
    expect(op1?.status).toBe("PENDING");
    expect(op1?.attempts).toBe(1);
    expect(op1?.lastError).not.toContain("super-secret-token");
    expect(op1?.lastError).toContain("[REDACTED]");

    // Cycle 2: storage recovers for keyFailThenRecover, keyPermanentFail still fails and reaches maxAttempts (2) -> FAILED
    h.failDeleteKeys.delete(keyFailThenRecover);
    h.advanceMs(2 * 60 * 1000);

    const cycle2 = await h.handler.runCleanupCycle();
    expect(cycle2.reconciledFileObjectIds).toEqual(["file-fail-recover"]);
    expect(cycle2.failedReconciliationIds).toHaveLength(1);
    expect(h.storedBinaries.has(keyFailThenRecover)).toBe(false);
    expect(h.fileObjects.get("file-fail-recover")?.status).toBe("MISSING");

    const op2 = Array.from(h.operations.values()).find((o) => o.fileObjectId === "file-perm-fail");
    expect(op2?.status).toBe("FAILED");
    expect(op2?.attempts).toBe(2);
    expect(h.fileObjects.get("file-perm-fail")?.status).toBe("DELETE_PENDING");
  });
});
