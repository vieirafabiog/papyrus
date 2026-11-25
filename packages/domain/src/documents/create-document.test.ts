import { describe, expect, it } from "vitest";
import type { UserEntity } from "../access/access.types.js";
import type { CategoryEntity, CategoryFieldEntity } from "../categories/category.types.js";
import type { FolderEntity } from "../folders/folder.types.js";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditRepositoryPort,
} from "../ports/audit-repository.port.js";
import type { CategoryRepositoryPort } from "../ports/category-repository.port.js";
import type {
  CreateDocumentInput,
  CreateDocumentVersionInput,
  DocumentRepositoryPort,
  DocumentVersionRepositoryPort,
} from "../ports/document-repository.port.js";
import type { FolderRepositoryPort } from "../ports/folder-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import type {
  UploadSessionEntity,
  UploadSessionRepositoryPort,
} from "../ports/upload-session-repository.port.js";
import type { UserRepositoryPort } from "../ports/user-repository.port.js";
import { createDocumentUseCase } from "./create-document.js";
import type {
  DocumentEntity,
  DocumentMetadataMap,
  DocumentVersionEntity,
  FileObjectEntity,
} from "./document.types.js";

function createTestHarness() {
  const orgId = "org-1";
  const actorId = "user-actor";
  const ownerId = "user-owner";
  const categoryId = "cat-1";
  const folderId = "folder-1";
  const sessionId = "session-1";
  const fileObjectId = "file-1";
  let seq = 0;

  const docs = new Map<string, DocumentEntity>();
  const versions = new Map<string, DocumentVersionEntity>();
  const syncedMetadata = new Map<string, DocumentMetadataMap>();
  const auditEvents: AuditEventRecord[] = [];

  const categoryStore = new Map<string, CategoryEntity>([
    [
      categoryId,
      {
        id: categoryId,
        organizationId: orgId,
        name: "Contratos",
        description: null,
        color: null,
        icon: null,
        isActive: true,
        textIndexingMode: "NEVER",
        createdAt: "2026-11-20T10:00:00Z",
        updatedAt: "2026-11-20T10:00:00Z",
      },
    ],
  ]);

  const categoryFields: CategoryFieldEntity[] = [
    {
      id: "field-1",
      categoryId,
      key: "fornecedor",
      label: "Fornecedor",
      type: "TEXT",
      required: true,
      options: null,
      sortOrder: 0,
      createdAt: "2026-11-20T10:00:00Z",
      updatedAt: "2026-11-20T10:00:00Z",
    },
  ];

  const folderStore = new Map<string, FolderEntity>([
    [
      folderId,
      {
        id: folderId,
        organizationId: orgId,
        parentId: null,
        name: "Jurídico",
        materializedPath: `/${folderId}`,
        status: "ACTIVE",
        createdAt: "2026-11-20T10:00:00Z",
        updatedAt: "2026-11-20T10:00:00Z",
      },
    ],
  ]);

  const userStore = new Map<string, UserEntity>([
    [
      actorId,
      {
        id: actorId,
        organizationId: orgId,
        email: "actor@papyrus.local",
        fullName: "Actor User",
        status: "ACTIVE",
        createdAt: "2026-11-20T10:00:00Z",
        updatedAt: "2026-11-20T10:00:00Z",
      },
    ],
    [
      ownerId,
      {
        id: ownerId,
        organizationId: orgId,
        email: "owner@papyrus.local",
        fullName: "Owner User",
        status: "ACTIVE",
        createdAt: "2026-11-20T10:00:00Z",
        updatedAt: "2026-11-20T10:00:00Z",
      },
    ],
  ]);

  const uploadSessionStore = new Map<string, UploadSessionEntity>([
    [
      sessionId,
      {
        id: sessionId,
        organizationId: orgId,
        userId: actorId,
        storageConnectionId: "conn-1",
        fileObjectId,
        declaredSizeBytes: 1024,
        declaredContentType: "application/pdf",
        idempotencyKey: "idem-1",
        status: "FINALIZED",
        expiresAt: "2026-11-21T10:00:00Z",
        finalizedAt: "2026-11-20T10:05:00Z",
        createdAt: "2026-11-20T10:00:00Z",
        updatedAt: "2026-11-20T10:05:00Z",
      },
    ],
  ]);

  const fileObjectStore = new Map<string, FileObjectEntity>([
    [
      fileObjectId,
      {
        id: fileObjectId,
        storageConnectionId: "conn-1",
        objectKey: "org/org-1/tmp/obj-1",
        originalFileName: "contrato.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: "a".repeat(64),
        status: "QUARANTINED",
        createdAt: "2026-11-20T10:00:00Z",
      },
    ],
  ]);

  const documents: DocumentRepositoryPort = {
    async findById(id) {
      return docs.get(id) ?? null;
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
    async create(input: CreateDocumentInput) {
      const entity: DocumentEntity = {
        ...input,
        status: "DRAFT",
        currentVersionId: null,
        version: 1,
        createdAt: "2026-11-21T10:00:00Z",
        updatedAt: "2026-11-21T10:00:00Z",
      };
      docs.set(entity.id, entity);
      return entity;
    },
    async updateWithOptimisticLock() {
      return null;
    },
    async setCurrentVersion(docId, versionId, expectedVersion) {
      const existing = docs.get(docId);
      if (!existing || existing.version !== expectedVersion) {
        return null;
      }
      const updated = {
        ...existing,
        currentVersionId: versionId,
        version: existing.version + 1,
      };
      docs.set(docId, updated);
      return updated;
    },
    async updateStatus(docId, status, expectedVersion) {
      const existing = docs.get(docId);
      if (!existing || existing.version !== expectedVersion) {
        return null;
      }
      const updated = {
        ...existing,
        status,
        version: existing.version + 1,
      };
      docs.set(docId, updated);
      return updated;
    },
    async syncMetadataRows(input) {
      syncedMetadata.set(input.documentId, input.metadata);
    },
  };

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
    async listByDocumentId() {
      return [];
    },
    async create(input: CreateDocumentVersionInput) {
      const entity: DocumentVersionEntity = {
        ...input,
        createdAt: "2026-11-21T10:00:00Z",
      };
      versions.set(entity.id, entity);
      return entity;
    },
  };

  const categories = {
    async findById(id: string) {
      return categoryStore.get(id) ?? null;
    },
    async listFields() {
      return categoryFields;
    },
  } as unknown as CategoryRepositoryPort;

  const folders = {
    async findById(id: string) {
      return folderStore.get(id) ?? null;
    },
  } as unknown as FolderRepositoryPort;

  const users = {
    async findById(id: string) {
      return userStore.get(id) ?? null;
    },
  } as unknown as UserRepositoryPort;

  const uploadSessions = {
    async findById(id: string) {
      return uploadSessionStore.get(id) ?? null;
    },
    async findFileObjectById(id: string) {
      return fileObjectStore.get(id) ?? null;
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
        occurredAt: "2026-11-21T10:00:00Z",
      };
      auditEvents.push(record);
      return record;
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  const service = createDocumentUseCase({
    documents,
    documentVersions,
    categories,
    folders,
    users,
    uploadSessions,
    transactions,
    audit,
    generateId: () => `id-${++seq}`,
    now: () => new Date("2026-11-21T10:00:00Z"),
  });

  return {
    service,
    orgId,
    actorId,
    ownerId,
    categoryId,
    folderId,
    sessionId,
    fileObjectId,
    uploadSessionStore,
    fileObjectStore,
    categoryStore,
    folderStore,
    syncedMetadata,
    auditEvents,
  };
}

describe("createDocumentUseCase", () => {
  it("creates a document with category, folder, owner, validated metadata, linked upload version 1 and DRAFT status", async () => {
    const h = createTestHarness();

    const result = await h.service.createDocument({
      organizationId: h.orgId,
      actorUserId: h.actorId,
      requestId: "req-1",
      title: "  Contrato ACME 2026  ",
      categoryId: h.categoryId,
      folderId: h.folderId,
      ownerUserId: h.ownerId,
      issueDate: "2026-01-10",
      expirationDate: "2026-12-31",
      metadata: { fornecedor: "  ACME Ltda  " },
      uploadSessionId: h.sessionId,
      changeNote: "Versão inicial",
    });

    expect(result.document.title).toBe("Contrato ACME 2026");
    expect(result.document.status).toBe("DRAFT");
    expect(result.document.ownerUserId).toBe(h.ownerId);
    expect(result.document.currentVersionId).toBe(result.initialVersion.id);
    expect(result.initialVersion.versionNumber).toBe(1);
    expect(result.initialVersion.fileObjectId).toBe(h.fileObjectId);
    expect(result.document.metadata).toEqual({ fornecedor: "ACME Ltda" });
    expect(h.syncedMetadata.get(result.document.id)).toEqual({ fornecedor: "ACME Ltda" });
    expect(h.auditEvents.map((e) => e.action)).toEqual(["DOCUMENT_CREATED"]);
  });

  it("rejects APPROVED status on initial submission, unfinalized upload, invalid metadata, and duplicate upload reuse", async () => {
    const h = createTestHarness();

    await expect(
      h.service.createDocument({
        organizationId: h.orgId,
        actorUserId: h.actorId,
        requestId: "req-1",
        title: "Tentativa Aprovada",
        categoryId: h.categoryId,
        folderId: h.folderId,
        issueDate: null,
        expirationDate: null,
        metadata: { fornecedor: "ACME" },
        uploadSessionId: h.sessionId,
        initialStatus: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INITIAL_DOCUMENT_STATUS" });

    // Sending IN_REVIEW while file is still QUARANTINED is rejected
    await expect(
      h.service.createDocument({
        organizationId: h.orgId,
        actorUserId: h.actorId,
        requestId: "req-2",
        title: "Em quarentena",
        categoryId: h.categoryId,
        folderId: h.folderId,
        issueDate: null,
        expirationDate: null,
        metadata: { fornecedor: "ACME" },
        uploadSessionId: h.sessionId,
        initialStatus: "IN_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_READY_FOR_REVIEW" });

    // Missing required metadata field is rejected
    await expect(
      h.service.createDocument({
        organizationId: h.orgId,
        actorUserId: h.actorId,
        requestId: "req-3",
        title: "Sem metadado obrigatório",
        categoryId: h.categoryId,
        folderId: h.folderId,
        issueDate: null,
        expirationDate: null,
        metadata: {},
        uploadSessionId: h.sessionId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT_METADATA" });

    // Unfinalized upload session is rejected
    const existingSession = h.uploadSessionStore.get(h.sessionId);
    if (!existingSession) {
      throw new Error("Missing upload session");
    }
    h.uploadSessionStore.set(h.sessionId, { ...existingSession, status: "UPLOADED" });
    await expect(
      h.service.createDocument({
        organizationId: h.orgId,
        actorUserId: h.actorId,
        requestId: "req-4",
        title: "Upload não finalizado",
        categoryId: h.categoryId,
        folderId: h.folderId,
        issueDate: null,
        expirationDate: null,
        metadata: { fornecedor: "ACME" },
        uploadSessionId: h.sessionId,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_NOT_FINALIZED" });

    // Mark AVAILABLE and FINALIZED -> first creation IN_REVIEW succeeds, reusing same finalized upload fails
    h.uploadSessionStore.set(h.sessionId, { ...existingSession, status: "FINALIZED" });
    const existingFile = h.fileObjectStore.get(h.fileObjectId);
    if (!existingFile) {
      throw new Error("Missing file object");
    }
    h.fileObjectStore.set(h.fileObjectId, { ...existingFile, status: "AVAILABLE" });

    const created = await h.service.createDocument({
      organizationId: h.orgId,
      actorUserId: h.actorId,
      requestId: "req-5",
      title: "Documento Pronto",
      categoryId: h.categoryId,
      folderId: h.folderId,
      issueDate: null,
      expirationDate: null,
      metadata: { fornecedor: "ACME" },
      uploadSessionId: h.sessionId,
      initialStatus: "IN_REVIEW",
    });
    expect(created.document.status).toBe("IN_REVIEW");

    await expect(
      h.service.createDocument({
        organizationId: h.orgId,
        actorUserId: h.actorId,
        requestId: "req-6",
        title: "Reuso de upload",
        categoryId: h.categoryId,
        folderId: h.folderId,
        issueDate: null,
        expirationDate: null,
        metadata: { fornecedor: "ACME" },
        uploadSessionId: h.sessionId,
      }),
    ).rejects.toMatchObject({ code: "FILE_ALREADY_LINKED_TO_DOCUMENT" });
  });
});
