import { describe, expect, it } from "vitest";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditRepositoryPort,
} from "../ports/audit-repository.port.js";
import type {
  CategoryRepositoryPort,
  CreateCategoryInput,
  UpdateCategoryInput,
} from "../ports/category-repository.port.js";
import type { PaginatedResult } from "../ports/document-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import { createCategoryService, resolveCategoryTextIndexingDecision } from "./category-service.js";
import type {
  AuthorizedCategoryQueryScope,
  CategoryEntity,
  CategoryListFilter,
} from "./category.types.js";

function createInMemoryCategoryHarness() {
  const store = new Map<string, CategoryEntity>();
  const documentCounts = new Map<string, number>();
  const auditEvents: AuditEventRecord[] = [];
  let seq = 0;

  const categories: CategoryRepositoryPort = {
    async findById(id: string): Promise<CategoryEntity | null> {
      return store.get(id) ?? null;
    },
    async findByName(organizationId: string, name: string): Promise<CategoryEntity | null> {
      for (const item of store.values()) {
        if (item.organizationId === organizationId && item.name === name) {
          return item;
        }
      }
      return null;
    },
    async countExistingDocuments(_organizationId: string, categoryId: string): Promise<number> {
      return documentCounts.get(categoryId) ?? 0;
    },
    async listAuthorized(
      filter: CategoryListFilter,
      _scope: AuthorizedCategoryQueryScope,
    ): Promise<PaginatedResult<CategoryEntity>> {
      const items = [...store.values()].filter(
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
    async create(input: CreateCategoryInput): Promise<CategoryEntity> {
      const now = new Date().toISOString();
      const entity: CategoryEntity = {
        id: input.id,
        organizationId: input.organizationId,
        name: input.name,
        description: input.description,
        color: input.color,
        icon: input.icon,
        isActive: true,
        textIndexingMode: input.textIndexingMode ?? "NEVER",
        createdAt: now,
        updatedAt: now,
      };
      store.set(entity.id, entity);
      return entity;
    },
    async update(input: UpdateCategoryInput): Promise<CategoryEntity | null> {
      const existing = store.get(input.id);
      if (!existing || existing.organizationId !== input.organizationId) {
        return null;
      }
      const updated: CategoryEntity = {
        ...existing,
        name: input.name ?? existing.name,
        description: input.description !== undefined ? input.description : existing.description,
        color: input.color !== undefined ? input.color : existing.color,
        icon: input.icon !== undefined ? input.icon : existing.icon,
        isActive: input.isActive !== undefined ? input.isActive : existing.isActive,
        textIndexingMode:
          input.textIndexingMode !== undefined ? input.textIndexingMode : existing.textIndexingMode,
        updatedAt: new Date().toISOString(),
      };
      store.set(updated.id, updated);
      return updated;
    },
    async listFields() {
      return [];
    },
    async findFieldById() {
      return null;
    },
    async findFieldByKey() {
      return null;
    },
    async createField(input) {
      const now = new Date().toISOString();
      return { ...input, createdAt: now, updatedAt: now };
    },
    async updateField() {
      return null;
    },
    async deleteField() {
      return false;
    },
    async listExistingDocumentMetadata() {
      return [];
    },
    async backfillFieldMetadata() {},
    async resetFieldMetadata() {},
    async removeFieldMetadata() {},
  };

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

  const service = createCategoryService({
    categories,
    transactions,
    audit,
    generateId: () => `cat-${++seq}`,
  });

  return { service, documentCounts, auditEvents };
}

describe("CategoryService", () => {
  it("creates, updates and rejects duplicate category names", async () => {
    const { service, auditEvents } = createInMemoryCategoryHarness();
    const created = await service.createCategory({
      organizationId: "org-1",
      actorUserId: "user-1",
      requestId: "req-1",
      name: "  Contratos  ",
      description: "Documentos contratuais",
      color: "#1b5e20",
      icon: "description",
    });

    expect(created.name).toBe("Contratos");
    expect(created.color).toBe("#1B5E20");
    expect(created.isActive).toBe(true);

    await expect(
      service.createCategory({
        organizationId: "org-1",
        actorUserId: "user-1",
        requestId: "req-2",
        name: "Contratos",
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_NAME_ALREADY_IN_USE" });

    const updated = await service.updateCategory({
      organizationId: "org-1",
      actorUserId: "user-1",
      requestId: "req-3",
      categoryId: created.id,
      name: "Contratos Comerciais",
      color: null,
    });
    expect(updated.name).toBe("Contratos Comerciais");
    expect(updated.color).toBeNull();
    expect(auditEvents.map((e) => e.action)).toEqual(["CATEGORY_CREATED", "CATEGORY_UPDATED"]);
  });

  it("blocks deactivation when existing documents are linked and allows deactivation once unlinked", async () => {
    const { service, documentCounts, auditEvents } = createInMemoryCategoryHarness();
    const cat = await service.createCategory({
      organizationId: "org-1",
      actorUserId: "user-1",
      requestId: "req-1",
      name: "Fiscal",
    });

    documentCounts.set(cat.id, 2);

    await expect(
      service.deactivateCategory({
        organizationId: "org-1",
        actorUserId: "user-1",
        requestId: "req-2",
        categoryId: cat.id,
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_HAS_EXISTING_DOCUMENTS" });

    await expect(
      service.updateCategory({
        organizationId: "org-1",
        actorUserId: "user-1",
        requestId: "req-3",
        categoryId: cat.id,
        isActive: false,
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_HAS_EXISTING_DOCUMENTS" });

    documentCounts.set(cat.id, 0);
    const deactivated = await service.deactivateCategory({
      organizationId: "org-1",
      actorUserId: "user-1",
      requestId: "req-4",
      categoryId: cat.id,
    });
    expect(deactivated.isActive).toBe(false);
    expect(auditEvents.map((e) => e.action)).toContain("CATEGORY_DEACTIVATED");
  });

  it("persists textIndexingMode policy per category and resolves server indexing intent", async () => {
    const { service } = createInMemoryCategoryHarness();

    const defaultCat = await service.createCategory({
      organizationId: "org-1",
      actorUserId: "user-1",
      requestId: "req-default",
      name: "Geral",
    });
    expect(defaultCat.textIndexingMode).toBe("NEVER");

    const alwaysCat = await service.createCategory({
      organizationId: "org-1",
      actorUserId: "user-1",
      requestId: "req-always",
      name: "Fiscais",
      textIndexingMode: "ALWAYS",
    });
    expect(alwaysCat.textIndexingMode).toBe("ALWAYS");

    const updated = await service.updateCategory({
      organizationId: "org-1",
      actorUserId: "user-1",
      requestId: "req-ask",
      categoryId: alwaysCat.id,
      textIndexingMode: "ASK",
    });
    expect(updated.textIndexingMode).toBe("ASK");

    expect(resolveCategoryTextIndexingDecision("NEVER", true)).toBe(false);
    expect(resolveCategoryTextIndexingDecision("NEVER", null)).toBe(false);
    expect(resolveCategoryTextIndexingDecision("ALWAYS", false)).toBe(true);
    expect(resolveCategoryTextIndexingDecision("ALWAYS", null)).toBe(true);
    expect(resolveCategoryTextIndexingDecision("ASK", true)).toBe(true);
    expect(resolveCategoryTextIndexingDecision("ASK", false)).toBe(false);
    expect(resolveCategoryTextIndexingDecision("ASK", null)).toBe(false);
  });
});
