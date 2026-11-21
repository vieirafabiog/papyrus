import { describe, expect, it } from "vitest";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditRepositoryPort,
} from "../ports/audit-repository.port.js";
import type { DocumentRepositoryPort } from "../ports/document-repository.port.js";
import type { FolderRepositoryPort } from "../ports/folder-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import { archiveDocumentUseCase } from "./archive-document.js";
import type { DocumentEntity, DocumentStatus } from "./document.types.js";
import { moveDocumentUseCase } from "./move-document.js";

function createMoveArchiveHarness(initialStatus: DocumentStatus = "APPROVED") {
  const orgId = "org-1";
  const docId = "doc-1";
  const userId = "user-1";

  const docs = new Map<string, DocumentEntity>([
    [
      docId,
      {
        id: docId,
        organizationId: orgId,
        title: "Contrato Vigente",
        categoryId: "cat-1",
        folderId: "folder-a",
        status: initialStatus,
        currentVersionId: "ver-1",
        ownerUserId: userId,
        issueDate: null,
        expirationDate: null,
        metadata: {},
        version: 1,
        createdAt: "2026-11-20T10:00:00Z",
        updatedAt: "2026-11-20T10:00:00Z",
      },
    ],
  ]);

  const foldersMap = new Map([
    [
      "folder-a",
      {
        id: "folder-a",
        organizationId: orgId,
        parentId: null,
        name: "Origem",
        materializedPath: "/folder-a",
        status: "ACTIVE" as const,
        createdAt: "2026-11-20T09:00:00Z",
        updatedAt: "2026-11-20T09:00:00Z",
      },
    ],
    [
      "folder-b",
      {
        id: "folder-b",
        organizationId: orgId,
        parentId: null,
        name: "Destino",
        materializedPath: "/folder-b",
        status: "ACTIVE" as const,
        createdAt: "2026-11-20T09:00:00Z",
        updatedAt: "2026-11-20T09:00:00Z",
      },
    ],
    [
      "folder-archived",
      {
        id: "folder-archived",
        organizationId: orgId,
        parentId: null,
        name: "Arquivada",
        materializedPath: "/folder-archived",
        status: "ARCHIVED" as const,
        createdAt: "2026-11-20T09:00:00Z",
        updatedAt: "2026-11-20T09:00:00Z",
      },
    ],
  ]);

  const auditEvents: AuditEventRecord[] = [];

  const documents = {
    async findById(id: string) {
      return docs.get(id) ?? null;
    },
    async updateWithOptimisticLock(
      id: string,
      expectedVersion: number,
      patch: { folderId?: string | null },
    ) {
      const existing = docs.get(id);
      if (!existing || existing.version !== expectedVersion) {
        return null;
      }
      const updated = {
        ...existing,
        folderId: patch.folderId !== undefined ? patch.folderId : existing.folderId,
        version: existing.version + 1,
      };
      docs.set(id, updated);
      return updated;
    },
    async updateStatus(id: string, status: DocumentStatus, expectedVersion: number) {
      const existing = docs.get(id);
      if (!existing || existing.version !== expectedVersion) {
        return null;
      }
      const updated = {
        ...existing,
        status,
        version: existing.version + 1,
      };
      docs.set(id, updated);
      return updated;
    },
  } as unknown as DocumentRepositoryPort;

  const folders = {
    async findById(id: string) {
      return foldersMap.get(id) ?? null;
    },
  } as unknown as FolderRepositoryPort;

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
        occurredAt: "2026-11-21T10:30:00Z",
      };
      auditEvents.push(record);
      return record;
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  return {
    orgId,
    docId,
    userId,
    auditEvents,
    moveService: moveDocumentUseCase({ documents, folders, transactions, audit }),
    archiveService: archiveDocumentUseCase({ documents, transactions, audit }),
  };
}

describe("moveDocumentUseCase & archiveDocumentUseCase", () => {
  it("moves a document to an active folder or root, rejects archived folders, and records audit", async () => {
    const h = createMoveArchiveHarness("APPROVED");

    await expect(
      h.moveService.moveDocument({
        organizationId: h.orgId,
        actorUserId: h.userId,
        requestId: "req-1",
        documentId: h.docId,
        expectedVersion: 1,
        targetFolderId: "folder-archived",
      }),
    ).rejects.toMatchObject({ code: "FOLDER_ARCHIVED" });

    const moved = await h.moveService.moveDocument({
      organizationId: h.orgId,
      actorUserId: h.userId,
      requestId: "req-2",
      documentId: h.docId,
      expectedVersion: 1,
      targetFolderId: "folder-b",
    });

    expect(moved.folderId).toBe("folder-b");
    expect(moved.version).toBe(2);
    expect(h.auditEvents[0]?.action).toBe("DOCUMENT_MOVED");
    expect(h.auditEvents[0]?.metadata).toEqual({
      fromFolderId: "folder-a",
      toFolderId: "folder-b",
    });
  });

  it("archives an eligible document and blocks archiving when document is IN_REVIEW or already ARCHIVED", async () => {
    const inReview = createMoveArchiveHarness("IN_REVIEW");
    await expect(
      inReview.archiveService.archiveDocument({
        organizationId: inReview.orgId,
        actorUserId: inReview.userId,
        requestId: "req-review",
        documentId: inReview.docId,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT_TRANSITION" });

    const approved = createMoveArchiveHarness("APPROVED");
    const archived = await approved.archiveService.archiveDocument({
      organizationId: approved.orgId,
      actorUserId: approved.userId,
      requestId: "req-archive",
      documentId: approved.docId,
      expectedVersion: 1,
      reason: "Contrato substituído pelo exercício seguinte",
    });

    expect(archived.status).toBe("ARCHIVED");
    expect(archived.version).toBe(2);
    expect(approved.auditEvents[0]?.action).toBe("DOCUMENT_ARCHIVED");

    await expect(
      approved.archiveService.archiveDocument({
        organizationId: approved.orgId,
        actorUserId: approved.userId,
        requestId: "req-archive-again",
        documentId: approved.docId,
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT_TRANSITION" });
  });
});
