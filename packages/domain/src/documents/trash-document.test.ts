import { describe, expect, it } from "vitest";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditRepositoryPort,
} from "../ports/audit-repository.port.js";
import type {
  DocumentListFilter,
  DocumentRepositoryPort,
} from "../ports/document-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import type { DocumentEntity, DocumentStatus, DocumentVersionEntity } from "./document.types.js";
import { trashDocumentUseCase } from "./trash-document.js";

function createTrashTestHarness(initialStatus: DocumentStatus = "APPROVED") {
  const orgId = "org-1";
  const docId = "doc-1";
  const userId = "user-1";

  const docs = new Map<string, DocumentEntity>([
    [
      docId,
      {
        id: docId,
        organizationId: orgId,
        title: "Contrato para Lixeira",
        categoryId: "cat-1",
        folderId: null,
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

  const preservedVersions: DocumentVersionEntity[] = [
    {
      id: "ver-1",
      documentId: docId,
      versionNumber: 1,
      fileObjectId: "file-1",
      uploadedByUserId: userId,
      changeNote: "Versão inicial",
      createdAt: "2026-11-20T10:00:00Z",
    },
  ];

  const auditEvents: AuditEventRecord[] = [];

  const documents = {
    async findById(id: string) {
      return docs.get(id) ?? null;
    },
    async list(filter: DocumentListFilter) {
      const items = [...docs.values()].filter(
        (doc) => doc.organizationId === filter.organizationId && doc.status !== "DELETED",
      );
      return {
        items,
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: items.length,
        totalPages: items.length > 0 ? 1 : 0,
      };
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
        occurredAt: "2026-11-21T10:45:00Z",
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
    documents,
    preservedVersions,
    auditEvents,
    service: trashDocumentUseCase({ documents, transactions, audit }),
  };
}

describe("trashDocumentUseCase", () => {
  it("marks document as DELETED, hides from standard listings, preserves versions and records audit", async () => {
    const h = createTrashTestHarness("APPROVED");

    const beforeList = await h.documents.list({
      organizationId: h.orgId,
      page: 1,
      pageSize: 20,
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
    expect(beforeList.items).toHaveLength(1);

    const trashed = await h.service.trashDocument({
      organizationId: h.orgId,
      actorUserId: h.userId,
      requestId: "req-trash-1",
      documentId: h.docId,
      expectedVersion: 1,
      reason: "Documento substituído",
    });

    expect(trashed.status).toBe("DELETED");
    expect(trashed.version).toBe(2);

    const afterList = await h.documents.list({
      organizationId: h.orgId,
      page: 1,
      pageSize: 20,
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
    expect(afterList.items).toHaveLength(0);
    expect(h.preservedVersions).toHaveLength(1);
    expect(h.auditEvents.map((e) => e.action)).toEqual(["DOCUMENT_TRASHED"]);
  });

  it("rejects trashing an already deleted document and enforces optimistic concurrency", async () => {
    const h = createTrashTestHarness("DRAFT");

    await expect(
      h.service.trashDocument({
        organizationId: h.orgId,
        actorUserId: h.userId,
        requestId: "req-stale",
        documentId: h.docId,
        expectedVersion: 99,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_VERSION_CONFLICT" });

    await h.service.trashDocument({
      organizationId: h.orgId,
      actorUserId: h.userId,
      requestId: "req-first",
      documentId: h.docId,
      expectedVersion: 1,
    });

    await expect(
      h.service.trashDocument({
        organizationId: h.orgId,
        actorUserId: h.userId,
        requestId: "req-second",
        documentId: h.docId,
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT_STATE" });
  });
});
