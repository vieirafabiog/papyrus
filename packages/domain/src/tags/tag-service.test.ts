import { describe, expect, it } from "vitest";
import type { DocumentEntity } from "../documents/document.types.js";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditRepositoryPort,
} from "../ports/audit-repository.port.js";
import type { DocumentRepositoryPort, PaginatedResult } from "../ports/document-repository.port.js";
import type {
  AttachDocumentTagRecordInput,
  CreateTagRecordInput,
  TagRepositoryPort,
} from "../ports/tag-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import { createTagService, normalizeTagName } from "./tag-service.js";
import type { TagEntity, TagListFilter } from "./tag.types.js";

function createInMemoryTagHarness() {
  const tagStore = new Map<string, TagEntity>();
  const docTagLinks = new Map<string, Set<string>>();
  const docStore = new Map<string, DocumentEntity>([
    [
      "doc-1",
      {
        id: "doc-1",
        organizationId: "org-1",
        title: "Contrato Anual",
        categoryId: "cat-1",
        folderId: null,
        status: "DRAFT",
        currentVersionId: null,
        ownerUserId: "user-1",
        issueDate: null,
        expirationDate: null,
        metadata: {},
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  ]);
  const auditEvents: AuditEventRecord[] = [];
  let seq = 0;

  const tags: TagRepositoryPort = {
    async findById(id: string): Promise<TagEntity | null> {
      return tagStore.get(id) ?? null;
    },
    async findByNormalizedName(
      organizationId: string,
      normalizedName: string,
    ): Promise<TagEntity | null> {
      for (const item of tagStore.values()) {
        if (item.organizationId === organizationId && item.normalizedName === normalizedName) {
          return item;
        }
      }
      return null;
    },
    async list(filter: TagListFilter): Promise<PaginatedResult<TagEntity>> {
      const items = [...tagStore.values()].filter(
        (item) => item.organizationId === filter.organizationId,
      );
      return {
        items,
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: items.length,
        totalPages: items.length === 0 ? 0 : 1,
      };
    },
    async create(input: CreateTagRecordInput): Promise<TagEntity> {
      const entity: TagEntity = {
        id: input.id,
        organizationId: input.organizationId,
        name: input.name,
        normalizedName: input.normalizedName,
        color: input.color,
        createdAt: new Date().toISOString(),
      };
      tagStore.set(entity.id, entity);
      return entity;
    },
    async listDocumentTags(
      organizationId: string,
      documentId: string,
    ): Promise<readonly TagEntity[]> {
      const linked = docTagLinks.get(documentId) ?? new Set<string>();
      return [...linked]
        .map((id) => tagStore.get(id))
        .filter(
          (item): item is TagEntity => item !== undefined && item.organizationId === organizationId,
        );
    },
    async isAttachedToDocument(documentId: string, tagId: string): Promise<boolean> {
      return docTagLinks.get(documentId)?.has(tagId) ?? false;
    },
    async attachToDocument(input: AttachDocumentTagRecordInput): Promise<void> {
      const set = docTagLinks.get(input.documentId) ?? new Set<string>();
      set.add(input.tagId);
      docTagLinks.set(input.documentId, set);
    },
    async detachFromDocument(documentId: string, tagId: string): Promise<boolean> {
      const set = docTagLinks.get(documentId);
      if (!set || !set.has(tagId)) {
        return false;
      }
      set.delete(tagId);
      return true;
    },
  };

  const documents = {
    async findById(id: string): Promise<DocumentEntity | null> {
      return docStore.get(id) ?? null;
    },
  } as unknown as DocumentRepositoryPort;

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({} as TransactionContext);
    },
  };

  const audit: AuditRepositoryPort = {
    async append(event: AuditEventInput): Promise<AuditEventRecord> {
      const record: AuditEventRecord = {
        ...event,
        id: `audit-${auditEvents.length + 1}`,
        occurredAt: new Date().toISOString(),
      };
      auditEvents.push(record);
      return record;
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  const service = createTagService({
    tags,
    documents,
    transactions,
    audit,
    generateId: () => `tag-${++seq}`,
  });

  return { service, auditEvents };
}

describe("TagService", () => {
  it("normalizes names, enforces case-insensitive uniqueness, attaches and detaches tags", async () => {
    expect(normalizeTagName("  Prioritário  ")).toEqual({
      name: "Prioritário",
      normalizedName: "prioritário",
    });

    const { service, auditEvents } = createInMemoryTagHarness();

    const created = await service.createTag({
      organizationId: "org-1",
      actorUserId: "user-1",
      requestId: "req-1",
      name: "Urgente",
      color: "#b71c1c",
    });
    expect(created.normalizedName).toBe("urgente");
    expect(created.color).toBe("#B71C1C");

    await expect(
      service.createTag({
        organizationId: "org-1",
        actorUserId: "user-1",
        requestId: "req-2",
        name: "  urgente ",
      }),
    ).rejects.toMatchObject({ code: "TAG_ALREADY_EXISTS" });

    const attached = await service.attachTagToDocument({
      organizationId: "org-1",
      actorUserId: "user-1",
      requestId: "req-3",
      documentId: "doc-1",
      tagId: created.id,
    });
    expect(attached.map((item) => item.id)).toEqual([created.id]);

    await expect(
      service.attachTagToDocument({
        organizationId: "org-1",
        actorUserId: "user-1",
        requestId: "req-4",
        documentId: "doc-1",
        tagId: created.id,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_TAG_ALREADY_ATTACHED" });

    const remaining = await service.detachTagFromDocument({
      organizationId: "org-1",
      actorUserId: "user-1",
      requestId: "req-5",
      documentId: "doc-1",
      tagId: created.id,
    });
    expect(remaining).toEqual([]);
    expect(auditEvents.map((e) => e.action)).toEqual([
      "TAG_CREATED",
      "DOCUMENT_TAG_ATTACHED",
      "DOCUMENT_TAG_DETACHED",
    ]);
  });
});
