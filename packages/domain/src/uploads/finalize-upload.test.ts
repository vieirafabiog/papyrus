import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AuditEventInput,
  AuditRepositoryPort,
  CreateDocumentVersionInput,
  DocumentEntity,
  DocumentRepositoryPort,
  DocumentVersionEntity,
  DocumentVersionRepositoryPort,
  FileObjectEntity,
  FinalizeUploadToQuarantineInput,
  MarkUploadReceivedInput,
  TransactionContext,
  TransactionManagerPort,
  UploadSessionEntity,
  UploadSessionRepositoryPort,
} from "../index.js";
import {
  type UploadObjectVerifierPort,
  type UploadProcessingEnqueueInput,
  type UploadProcessingQueuePort,
  type VerifiedUploadedObject,
  createFinalizeUploadService,
} from "./finalize-upload.js";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

interface TestHarnessState {
  sessions: Map<string, UploadSessionEntity>;
  fileObjects: Map<string, FileObjectEntity>;
  documents: Map<string, DocumentEntity>;
  versions: Map<string, DocumentVersionEntity>;
  storedObjects: Map<string, VerifiedUploadedObject>;
  queuedJobs: UploadProcessingEnqueueInput[];
  auditLogs: AuditEventInput[];
  clockMs: number;
}

function createHarness(initial?: Partial<TestHarnessState>) {
  const state: TestHarnessState = {
    sessions: initial?.sessions ?? new Map(),
    fileObjects: initial?.fileObjects ?? new Map(),
    documents: initial?.documents ?? new Map(),
    versions: initial?.versions ?? new Map(),
    storedObjects: initial?.storedObjects ?? new Map(),
    queuedJobs: initial?.queuedJobs ?? [],
    auditLogs: initial?.auditLogs ?? [],
    clockMs: initial?.clockMs ?? Date.parse("2026-11-21T12:00:00.000Z"),
  };

  let idSeq = 1;

  const uploads: UploadSessionRepositoryPort = {
    async findById(id) {
      return state.sessions.get(id) ?? null;
    },
    async findByIdempotencyKey(organizationId, userId, idempotencyKey) {
      for (const s of state.sessions.values()) {
        if (
          s.organizationId === organizationId &&
          s.userId === userId &&
          s.idempotencyKey === idempotencyKey
        ) {
          return s;
        }
      }
      return null;
    },
    async findFileObjectById(fileObjectId) {
      return state.fileObjects.get(fileObjectId) ?? null;
    },
    async createSessionWithFileObject(input) {
      const nowIso = new Date(state.clockMs).toISOString();
      const fileObject: FileObjectEntity = {
        id: input.fileObjectId,
        storageConnectionId: input.storageConnectionId,
        objectKey: input.objectKey,
        originalFileName: input.originalFileName,
        detectedContentType: input.declaredContentType,
        sizeBytes: input.declaredSizeBytes,
        checksumSha256: input.checksumSha256,
        status: "UPLOADING",
        createdAt: nowIso,
      };
      const session: UploadSessionEntity = {
        id: input.sessionId,
        organizationId: input.organizationId,
        userId: input.userId,
        storageConnectionId: input.storageConnectionId,
        fileObjectId: input.fileObjectId,
        declaredSizeBytes: input.declaredSizeBytes,
        declaredContentType: input.declaredContentType,
        idempotencyKey: input.idempotencyKey,
        status: "PENDING",
        expiresAt: input.expiresAt.toISOString(),
        finalizedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.fileObjects.set(fileObject.id, fileObject);
      state.sessions.set(session.id, session);
      return { session, fileObject };
    },
    async markUploadReceived(input: MarkUploadReceivedInput) {
      const existingSession = state.sessions.get(input.sessionId);
      if (!existingSession || existingSession.status !== "PENDING") {
        return null;
      }
      const existingFile = state.fileObjects.get(input.fileObjectId);
      if (!existingFile) {
        return null;
      }
      const nowIso = new Date(state.clockMs).toISOString();
      const nextSession: UploadSessionEntity = {
        ...existingSession,
        status: "UPLOADED",
        updatedAt: nowIso,
      };
      const nextFile: FileObjectEntity = {
        ...existingFile,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
      };
      state.sessions.set(nextSession.id, nextSession);
      state.fileObjects.set(nextFile.id, nextFile);
      return { session: nextSession, fileObject: nextFile };
    },
    async finalizeToQuarantine(input: FinalizeUploadToQuarantineInput) {
      const existingSession = state.sessions.get(input.sessionId);
      if (
        !existingSession ||
        (existingSession.status !== "PENDING" && existingSession.status !== "UPLOADED")
      ) {
        return null;
      }
      const existingFile = state.fileObjects.get(input.fileObjectId);
      if (!existingFile) {
        return null;
      }
      const nowIso = input.finalizedAt.toISOString();
      const nextSession: UploadSessionEntity = {
        ...existingSession,
        status: "FINALIZED",
        finalizedAt: nowIso,
        updatedAt: nowIso,
      };
      const nextFile: FileObjectEntity = {
        ...existingFile,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
        status: "QUARANTINED",
      };
      state.sessions.set(nextSession.id, nextSession);
      state.fileObjects.set(nextFile.id, nextFile);
      return { session: nextSession, fileObject: nextFile };
    },
    async markSessionExpired(sessionId) {
      const existing = state.sessions.get(sessionId);
      if (existing && existing.status === "PENDING") {
        state.sessions.set(sessionId, {
          ...existing,
          status: "EXPIRED",
          updatedAt: new Date(state.clockMs).toISOString(),
        });
      }
    },
  };

  const documents: DocumentRepositoryPort = {
    async findById(id) {
      return state.documents.get(id) ?? null;
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
    async create(input) {
      const nowIso = new Date(state.clockMs).toISOString();
      const doc: DocumentEntity = {
        id: input.id,
        organizationId: input.organizationId,
        title: input.title,
        categoryId: input.categoryId,
        folderId: input.folderId,
        status: "DRAFT",
        currentVersionId: null,
        ownerUserId: input.ownerUserId,
        issueDate: input.issueDate,
        expirationDate: input.expirationDate,
        metadata: input.metadata,
        version: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.documents.set(doc.id, doc);
      return doc;
    },
    async updateWithOptimisticLock() {
      return null;
    },
    async setCurrentVersion() {
      return null;
    },
    async updateStatus() {
      return null;
    },
  };

  const documentVersions: DocumentVersionRepositoryPort = {
    async findById(id) {
      return state.versions.get(id) ?? null;
    },
    async findByFileObjectId(fileObjectId) {
      for (const v of state.versions.values()) {
        if (v.fileObjectId === fileObjectId) {
          return v;
        }
      }
      return null;
    },
    async findLatestByDocumentId(documentId) {
      const matching = Array.from(state.versions.values())
        .filter((v) => v.documentId === documentId)
        .sort((a, b) => b.versionNumber - a.versionNumber);
      return matching[0] ?? null;
    },
    async listByDocumentId(documentId) {
      return Array.from(state.versions.values())
        .filter((v) => v.documentId === documentId)
        .sort((a, b) => b.versionNumber - a.versionNumber);
    },
    async create(input: CreateDocumentVersionInput) {
      const version: DocumentVersionEntity = {
        id: input.id,
        documentId: input.documentId,
        versionNumber: input.versionNumber,
        fileObjectId: input.fileObjectId,
        uploadedByUserId: input.uploadedByUserId,
        changeNote: input.changeNote,
        createdAt: new Date(state.clockMs).toISOString(),
      };
      state.versions.set(version.id, version);
      return version;
    },
  };

  const objectVerifier: UploadObjectVerifierPort = {
    async verifyUploadedObject({ storageConnectionId, objectKey }) {
      return state.storedObjects.get(`${storageConnectionId}:${objectKey}`) ?? null;
    },
  };

  const processingQueue: UploadProcessingQueuePort = {
    async enqueueProcessing(input) {
      state.queuedJobs.push(input);
    },
  };

  const audit: AuditRepositoryPort = {
    async append(input) {
      state.auditLogs.push(input);
      return {
        ...input,
        id: `audit-${state.auditLogs.length}`,
        occurredAt: new Date(state.clockMs).toISOString(),
      };
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      const tx: TransactionContext = { __brand: "TransactionContext" };
      return fn(tx);
    },
  };

  const service = createFinalizeUploadService({
    uploads,
    objectVerifier,
    transactions,
    audit,
    documents,
    documentVersions,
    processingQueue,
    generateId: () => `gen-id-${idSeq++}`,
    now: () => new Date(state.clockMs),
  });

  const seedDocumentAndSession = (overrides?: {
    sessionStatus?: UploadSessionEntity["status"];
    fileStatus?: FileObjectEntity["status"];
    declaredSizeBytes?: number;
    fileChecksum?: string;
    expiresAtMs?: number;
    userId?: string;
  }) => {
    const orgId = "org-1";
    const userId = overrides?.userId ?? "user-1";
    const connId = "conn-s3-1";
    const docId = "doc-1";
    const fileObjectId = "file-obj-1";
    const sessionId = "session-1";
    const objectKey = `org/${orgId}/documents/${docId}/versions/pending/${fileObjectId}`;
    const sizeBytes = overrides?.declaredSizeBytes ?? 2048;

    state.documents.set(docId, {
      id: docId,
      organizationId: orgId,
      title: "Contrato Principal.pdf",
      categoryId: "cat-1",
      folderId: null,
      status: "DRAFT",
      currentVersionId: null,
      ownerUserId: userId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
      version: 1,
      createdAt: "2026-11-21T11:00:00.000Z",
      updatedAt: "2026-11-21T11:00:00.000Z",
    });

    state.fileObjects.set(fileObjectId, {
      id: fileObjectId,
      storageConnectionId: connId,
      objectKey,
      originalFileName: "Contrato.pdf",
      detectedContentType: "application/pdf",
      sizeBytes,
      checksumSha256: overrides?.fileChecksum ?? "0".repeat(64),
      status: overrides?.fileStatus ?? "UPLOADING",
      createdAt: "2026-11-21T11:50:00.000Z",
    });

    state.sessions.set(sessionId, {
      id: sessionId,
      organizationId: orgId,
      userId,
      storageConnectionId: connId,
      fileObjectId,
      declaredSizeBytes: sizeBytes,
      declaredContentType: "application/pdf",
      idempotencyKey: "idem-key-1",
      status: overrides?.sessionStatus ?? "PENDING",
      expiresAt: new Date(overrides?.expiresAtMs ?? state.clockMs + 300_000).toISOString(),
      finalizedAt: null,
      createdAt: "2026-11-21T11:50:00.000Z",
      updatedAt: "2026-11-21T11:50:00.000Z",
    });

    return { orgId, userId, connId, docId, fileObjectId, sessionId, objectKey, sizeBytes };
  };

  return { state, service, seedDocumentAndSession };
}

describe("Idempotent upload finalization (createFinalizeUploadService)", () => {
  it("rejects missing object, mismatched size, unverified checksum, or checksum mismatch before entering quarantine", async () => {
    const validChecksum = sha256Hex("valid-pdf-binary-payload");

    // 1. Missing object in storage
    {
      const { state, service, seedDocumentAndSession } = createHarness();
      const ids = seedDocumentAndSession();

      await expect(
        service.finalizeUpload({
          organizationId: ids.orgId,
          actorUserId: ids.userId,
          requestId: "req-1",
          sessionId: ids.sessionId,
          documentId: ids.docId,
        }),
      ).rejects.toMatchObject({ code: "UPLOAD_OBJECT_MISSING" });

      expect(state.sessions.get(ids.sessionId)?.status).toBe("PENDING");
      expect(state.fileObjects.get(ids.fileObjectId)?.status).toBe("UPLOADING");
      expect(state.versions.size).toBe(0);
      expect(state.queuedJobs).toHaveLength(0);
      expect(state.auditLogs).toHaveLength(0);
    }

    // 2. Object size divergence
    {
      const { state, service, seedDocumentAndSession } = createHarness();
      const ids = seedDocumentAndSession({ declaredSizeBytes: 2048 });
      state.storedObjects.set(`${ids.connId}:${ids.objectKey}`, {
        objectKey: ids.objectKey,
        contentLength: 1024,
        contentType: "application/pdf",
        checksumSha256: validChecksum,
      });

      await expect(
        service.finalizeUpload({
          organizationId: ids.orgId,
          actorUserId: ids.userId,
          requestId: "req-2",
          sessionId: ids.sessionId,
          documentId: ids.docId,
        }),
      ).rejects.toMatchObject({ code: "UPLOAD_SIZE_MISMATCH" });

      expect(state.fileObjects.get(ids.fileObjectId)?.status).toBe("UPLOADING");
      expect(state.versions.size).toBe(0);
    }

    // 3. Storage object returns null/placeholder checksum (unverified)
    {
      const { state, service, seedDocumentAndSession } = createHarness();
      const ids = seedDocumentAndSession();
      state.storedObjects.set(`${ids.connId}:${ids.objectKey}`, {
        objectKey: ids.objectKey,
        contentLength: ids.sizeBytes,
        contentType: "application/pdf",
        checksumSha256: "0".repeat(64),
      });

      await expect(
        service.finalizeUpload({
          organizationId: ids.orgId,
          actorUserId: ids.userId,
          requestId: "req-3",
          sessionId: ids.sessionId,
          documentId: ids.docId,
        }),
      ).rejects.toMatchObject({ code: "UPLOAD_CHECKSUM_UNVERIFIED" });

      expect(state.fileObjects.get(ids.fileObjectId)?.status).toBe("UPLOADING");
      expect(state.versions.size).toBe(0);
    }

    // 4. Storage checksum mismatches expected/recorded checksum
    {
      const wrongChecksum = sha256Hex("tampered-pdf-payload");
      const { state, service, seedDocumentAndSession } = createHarness();
      const ids = seedDocumentAndSession({ fileChecksum: validChecksum });
      state.storedObjects.set(`${ids.connId}:${ids.objectKey}`, {
        objectKey: ids.objectKey,
        contentLength: ids.sizeBytes,
        contentType: "application/pdf",
        checksumSha256: wrongChecksum,
      });

      await expect(
        service.finalizeUpload({
          organizationId: ids.orgId,
          actorUserId: ids.userId,
          requestId: "req-4",
          sessionId: ids.sessionId,
          expectedChecksumSha256: validChecksum,
          documentId: ids.docId,
        }),
      ).rejects.toMatchObject({ code: "UPLOAD_CHECKSUM_MISMATCH" });

      expect(state.sessions.get(ids.sessionId)?.status).toBe("PENDING");
      expect(state.fileObjects.get(ids.fileObjectId)?.status).toBe("UPLOADING");
      expect(state.versions.size).toBe(0);
      expect(state.queuedJobs).toHaveLength(0);
    }
  });

  it("quarantines verified object, creates single immutable version without exposing currentVersionId yet, and replays idempotently without duplicate versions", async () => {
    const payloadChecksum = sha256Hex("authentic-contract-pdf-bytes");
    const { state, service, seedDocumentAndSession } = createHarness();
    const ids = seedDocumentAndSession({ sessionStatus: "UPLOADED" });

    state.storedObjects.set(`${ids.connId}:${ids.objectKey}`, {
      objectKey: ids.objectKey,
      contentLength: ids.sizeBytes,
      contentType: "application/pdf",
      checksumSha256: payloadChecksum.toUpperCase(),
    });

    const first = await service.finalizeUpload({
      organizationId: ids.orgId,
      actorUserId: ids.userId,
      requestId: "req-finalize-1",
      sessionId: ids.sessionId,
      expectedChecksumSha256: payloadChecksum,
      documentId: ids.docId,
      changeNote: "Versão inicial enviada via S3",
    });

    expect(first.idempotentReplay).toBe(false);
    expect(first.processingEnqueued).toBe(true);
    expect(first.session.status).toBe("FINALIZED");
    expect(first.session.finalizedAt).not.toBeNull();
    expect(first.fileObject.status).toBe("QUARANTINED");
    expect(first.fileObject.checksumSha256).toBe(payloadChecksum);
    expect(first.documentVersion).not.toBeNull();
    expect(first.documentVersion?.versionNumber).toBe(1);
    expect(first.documentVersion?.fileObjectId).toBe(ids.fileObjectId);
    // Document currentVersionId must stay untouched until worker approves quarantine
    expect(state.documents.get(ids.docId)?.currentVersionId).toBeNull();
    expect(state.versions.size).toBe(1);
    expect(state.queuedJobs).toHaveLength(1);
    expect(state.auditLogs).toHaveLength(1);
    expect(state.auditLogs[0]?.action).toBe("UPLOAD_FINALIZED_TO_QUARANTINE");

    // Advance clock past expiresAt and simulate worker moving object to AVAILABLE:
    // repeated finalization MUST still succeed idempotently without creating duplicate versions
    state.clockMs += 3_600_000;
    const currentFile = state.fileObjects.get(ids.fileObjectId);
    if (currentFile) {
      state.fileObjects.set(ids.fileObjectId, { ...currentFile, status: "AVAILABLE" });
    }

    const replay = await service.finalizeUpload({
      organizationId: ids.orgId,
      actorUserId: ids.userId,
      requestId: "req-finalize-2",
      sessionId: ids.sessionId,
      expectedChecksumSha256: payloadChecksum,
      documentId: ids.docId,
    });

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.processingEnqueued).toBe(false);
    expect(replay.session.status).toBe("FINALIZED");
    expect(replay.documentVersion?.id).toBe(first.documentVersion?.id);
    expect(replay.documentVersion?.versionNumber).toBe(1);
    expect(state.versions.size).toBe(1);
    expect(state.queuedJobs).toHaveLength(1);
    expect(state.auditLogs).toHaveLength(1);
  });

  it("prevents duplicate versions under concurrent finalization calls and rejects conflicting replay payloads", async () => {
    const checksum = sha256Hex("concurrent-pdf-bytes");
    const { state, service, seedDocumentAndSession } = createHarness();
    const ids = seedDocumentAndSession();

    state.storedObjects.set(`${ids.connId}:${ids.objectKey}`, {
      objectKey: ids.objectKey,
      contentLength: ids.sizeBytes,
      contentType: "application/pdf",
      checksumSha256: checksum,
    });

    const [resA, resB] = await Promise.all([
      service.finalizeUpload({
        organizationId: ids.orgId,
        actorUserId: ids.userId,
        requestId: "req-concurrent-a",
        sessionId: ids.sessionId,
        documentId: ids.docId,
      }),
      service.finalizeUpload({
        organizationId: ids.orgId,
        actorUserId: ids.userId,
        requestId: "req-concurrent-b",
        sessionId: ids.sessionId,
        documentId: ids.docId,
      }),
    ]);

    const replayFlags = [resA.idempotentReplay, resB.idempotentReplay].sort();
    expect(replayFlags).toEqual([false, true]);
    expect(resA.documentVersion?.id).toBe(resB.documentVersion?.id);
    expect(state.versions.size).toBe(1);
    expect(state.queuedJobs).toHaveLength(1);
    expect(state.auditLogs).toHaveLength(1);

    // Conflicting replay documentId must fail explicitly without mutating versions
    await expect(
      service.finalizeUpload({
        organizationId: ids.orgId,
        actorUserId: ids.userId,
        requestId: "req-conflict-doc",
        sessionId: ids.sessionId,
        documentId: "other-doc-id",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_FINALIZATION_CONFLICT" });
    expect(state.versions.size).toBe(1);
  });

  it("enforces session ownership, organization isolation, and expiration before finalization", async () => {
    const checksum = sha256Hex("owned-pdf");
    const { state, service, seedDocumentAndSession } = createHarness();
    const ids = seedDocumentAndSession({ expiresAtMs: Date.parse("2026-11-21T11:55:00.000Z") });
    state.storedObjects.set(`${ids.connId}:${ids.objectKey}`, {
      objectKey: ids.objectKey,
      contentLength: ids.sizeBytes,
      contentType: "application/pdf",
      checksumSha256: checksum,
    });

    await expect(
      service.finalizeUpload({
        organizationId: "other-org",
        actorUserId: ids.userId,
        requestId: "req-org",
        sessionId: ids.sessionId,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_SESSION_NOT_FOUND" });

    await expect(
      service.finalizeUpload({
        organizationId: ids.orgId,
        actorUserId: "other-user",
        requestId: "req-user",
        sessionId: ids.sessionId,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_SESSION_FORBIDDEN" });

    await expect(
      service.finalizeUpload({
        organizationId: ids.orgId,
        actorUserId: ids.userId,
        requestId: "req-expired",
        sessionId: ids.sessionId,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_SESSION_EXPIRED" });

    expect(state.sessions.get(ids.sessionId)?.status).toBe("EXPIRED");
    expect(state.fileObjects.get(ids.fileObjectId)?.status).toBe("UPLOADING");
  });
});
