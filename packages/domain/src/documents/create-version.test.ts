import { describe, expect, it } from "vitest";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditRepositoryPort,
} from "../ports/audit-repository.port.js";
import type {
  CreateDocumentVersionInput,
  DocumentRepositoryPort,
  DocumentVersionRepositoryPort,
} from "../ports/document-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import type { UploadSessionRepositoryPort } from "../ports/upload-session-repository.port.js";
import { createDocumentVersionUseCase } from "./create-version.js";
import type { DocumentEntity, DocumentVersionEntity, FileObjectEntity } from "./document.types.js";

function createVersionTestHarness() {
  const orgId = "org-1";
  const docId = "doc-1";
  const userId = "user-1";
  let seq = 0;

  const docs = new Map<string, DocumentEntity>([
    [
      docId,
      {
        id: docId,
        organizationId: orgId,
        title: "Contrato Vigente",
        categoryId: "cat-1",
        folderId: null,
        status: "APPROVED",
        currentVersionId: "ver-1",
        ownerUserId: userId,
        issueDate: null,
        expirationDate: null,
        metadata: {},
        version: 2,
        createdAt: "2026-11-20T10:00:00Z",
        updatedAt: "2026-11-20T10:00:00Z",
      },
    ],
  ]);

  const versions = new Map<string, DocumentVersionEntity>([
    [
      "ver-1",
      {
        id: "ver-1",
        documentId: docId,
        versionNumber: 1,
        fileObjectId: "file-1",
        uploadedByUserId: userId,
        changeNote: "Versão inicial",
        createdAt: "2026-11-20T10:00:00Z",
      },
    ],
  ]);

  const fileObjects = new Map<
    string,
    { readonly orgId: string; readonly entity: FileObjectEntity }
  >([
    [
      "file-1",
      {
        orgId,
        entity: {
          id: "file-1",
          storageConnectionId: "conn-1",
          objectKey: "org/org-1/v1",
          originalFileName: "v1.pdf",
          detectedContentType: "application/pdf",
          sizeBytes: 1000,
          checksumSha256: "a".repeat(64),
          status: "AVAILABLE",
          createdAt: "2026-11-20T10:00:00Z",
        },
      },
    ],
    [
      "file-quarantined",
      {
        orgId,
        entity: {
          id: "file-quarantined",
          storageConnectionId: "conn-1",
          objectKey: "org/org-1/vq",
          originalFileName: "vq.pdf",
          detectedContentType: "application/pdf",
          sizeBytes: 1000,
          checksumSha256: "b".repeat(64),
          status: "QUARANTINED",
          createdAt: "2026-11-21T10:00:00Z",
        },
      },
    ],
    [
      "file-2",
      {
        orgId,
        entity: {
          id: "file-2",
          storageConnectionId: "conn-1",
          objectKey: "org/org-1/v2",
          originalFileName: "v2.pdf",
          detectedContentType: "application/pdf",
          sizeBytes: 2048,
          checksumSha256: "c".repeat(64),
          status: "AVAILABLE",
          createdAt: "2026-11-21T10:05:00Z",
        },
      },
    ],
  ]);

  const auditEvents: AuditEventRecord[] = [];

  const documents = {
    async findById(id: string) {
      return docs.get(id) ?? null;
    },
    async setCurrentVersion(id: string, versionId: string, expectedVersion: number) {
      const existing = docs.get(id);
      if (!existing || existing.version !== expectedVersion) {
        return null;
      }
      const updated = {
        ...existing,
        currentVersionId: versionId,
        version: existing.version + 1,
      };
      docs.set(id, updated);
      return updated;
    },
  } as unknown as DocumentRepositoryPort;

  const documentVersions: DocumentVersionRepositoryPort = {
    async findById(id) {
      return versions.get(id) ?? null;
    },
    async findByFileObjectId(fId) {
      for (const ver of versions.values()) {
        if (ver.fileObjectId === fId) {
          return ver;
        }
      }
      return null;
    },
    async findLatestByDocumentId() {
      return null;
    },
    async listByDocumentId(dId) {
      return [...versions.values()].filter((v) => v.documentId === dId);
    },
    async create(input: CreateDocumentVersionInput) {
      for (const v of versions.values()) {
        if (v.documentId === input.documentId && v.versionNumber === input.versionNumber) {
          throw new Error("Duplicate versionNumber");
        }
      }
      const entity: DocumentVersionEntity = {
        ...input,
        createdAt: "2026-11-21T10:10:00Z",
      };
      versions.set(entity.id, entity);
      return entity;
    },
  };

  const uploadSessions = {
    async findById() {
      return null;
    },
    async findFileObjectById(fId: string) {
      return fileObjects.get(fId)?.entity ?? null;
    },
    async findFileObjectOrganizationId(fId: string) {
      return fileObjects.get(fId)?.orgId ?? null;
    },
  } as unknown as UploadSessionRepositoryPort;

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({} as TransactionContext);
    },
  };

  const audit: AuditRepositoryPort = {
    async append(event: AuditEventInput) {
      const record: AuditEventRecord = {
        ...event,
        id: `audit-${auditEvents.length + 1}`,
        occurredAt: "2026-11-21T10:10:00Z",
      };
      auditEvents.push(record);
      return record;
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  const service = createDocumentVersionUseCase({
    documents,
    documentVersions,
    uploadSessions,
    transactions,
    audit,
    generateId: () => `ver-${++seq + 1}`,
    now: () => new Date("2026-11-21T10:10:00Z"),
  });

  return { service, docId, orgId, userId, docs, versions, auditEvents };
}

describe("createDocumentVersionUseCase", () => {
  it("appends a new version with an available FileObject, rejects non-available or reused files, and enforces optimistic concurrency", async () => {
    const h = createVersionTestHarness();

    // Non-AVAILABLE file rejected
    await expect(
      h.service.createVersion({
        organizationId: h.orgId,
        actorUserId: h.userId,
        requestId: "req-1",
        documentId: h.docId,
        expectedVersion: 2,
        fileObjectId: "file-quarantined",
      }),
    ).rejects.toMatchObject({ code: "FILE_OBJECT_NOT_AVAILABLE" });

    // Reused file object rejected
    await expect(
      h.service.createVersion({
        organizationId: h.orgId,
        actorUserId: h.userId,
        requestId: "req-2",
        documentId: h.docId,
        expectedVersion: 2,
        fileObjectId: "file-1",
      }),
    ).rejects.toMatchObject({ code: "FILE_ALREADY_LINKED_TO_DOCUMENT" });

    // Stale expectedVersion rejected cleanly
    await expect(
      h.service.createVersion({
        organizationId: h.orgId,
        actorUserId: h.userId,
        requestId: "req-3",
        documentId: h.docId,
        expectedVersion: 1,
        fileObjectId: "file-2",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_VERSION_CONFLICT" });

    // Valid creation produces version 2 and advances document lock version to 3
    const result = await h.service.createVersion({
      organizationId: h.orgId,
      actorUserId: h.userId,
      requestId: "req-4",
      documentId: h.docId,
      expectedVersion: 2,
      fileObjectId: "file-2",
      changeNote: "Aditivo assinado",
    });

    expect(result.version.versionNumber).toBe(2);
    expect(result.document.currentVersionId).toBe(result.version.id);
    expect(result.document.version).toBe(3);
    expect(h.versions.has("ver-1")).toBe(true);
    expect(h.auditEvents.map((e) => e.action)).toEqual(["DOCUMENT_VERSION_CREATED"]);

    // Subsequent call using stale expectedVersion 2 fails with conflict
    await expect(
      h.service.createVersion({
        organizationId: h.orgId,
        actorUserId: h.userId,
        requestId: "req-5",
        documentId: h.docId,
        expectedVersion: 2,
        fileObjectId: "file-2",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_VERSION_CONFLICT" });
  });

  it("restores a historical version by creating an append-only new version without rewriting history", async () => {
    const h = createVersionTestHarness();

    const v2 = await h.service.createVersion({
      organizationId: h.orgId,
      actorUserId: h.userId,
      requestId: "req-create-v2",
      documentId: h.docId,
      expectedVersion: 2,
      fileObjectId: "file-2",
      changeNote: "Segunda versão",
    });

    // Cannot restore current version
    await expect(
      h.service.restoreVersion({
        organizationId: h.orgId,
        actorUserId: h.userId,
        requestId: "req-restore-current",
        documentId: h.docId,
        targetVersionId: v2.version.id,
        expectedVersion: 3,
      }),
    ).rejects.toMatchObject({ code: "VERSION_ALREADY_CURRENT" });

    // Restoring v1 creates v3 linked to file-1 and preserves v1 + v2 untouched
    const v3 = await h.service.restoreVersion({
      organizationId: h.orgId,
      actorUserId: h.userId,
      requestId: "req-restore-v1",
      documentId: h.docId,
      targetVersionId: "ver-1",
      expectedVersion: 3,
    });

    expect(v3.version.versionNumber).toBe(3);
    expect(v3.version.fileObjectId).toBe("file-1");
    expect(v3.version.changeNote).toBe("Restauração lógica da versão 1");
    expect(v3.document.currentVersionId).toBe(v3.version.id);
    expect(v3.document.version).toBe(4);
    expect(h.versions.size).toBe(3);
    expect(h.versions.get("ver-1")?.versionNumber).toBe(1);
    expect(h.versions.get(v2.version.id)?.versionNumber).toBe(2);
    expect(h.auditEvents.map((e) => e.action)).toEqual([
      "DOCUMENT_VERSION_CREATED",
      "DOCUMENT_VERSION_RESTORED",
    ]);
  });
});
