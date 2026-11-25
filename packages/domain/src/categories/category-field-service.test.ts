import { describe, expect, it } from "vitest";
import type { DocumentMetadataMap, DocumentMetadataValue } from "../documents/document.types.js";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditRepositoryPort,
} from "../ports/audit-repository.port.js";
import type {
  CategoryRepositoryPort,
  CreateCategoryFieldRecordInput,
  CreateCategoryInput,
  ExistingDocumentMetadataSnapshot,
  UpdateCategoryFieldRecordInput,
  UpdateCategoryInput,
} from "../ports/category-repository.port.js";
import type { PaginatedResult } from "../ports/document-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import { createCategoryFieldService } from "./category-field-service.js";
import type {
  AuthorizedCategoryQueryScope,
  CategoryEntity,
  CategoryFieldEntity,
  CategoryListFilter,
} from "./category.types.js";

function createInMemoryFieldHarness() {
  const categoryId = "cat-1";
  const organizationId = "org-1";
  const categoryStore = new Map<string, CategoryEntity>([
    [
      categoryId,
      {
        id: categoryId,
        organizationId,
        name: "Contratos",
        description: null,
        color: null,
        icon: null,
        isActive: true,
        textIndexingMode: "NEVER",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  ]);
  const fieldStore = new Map<string, CategoryFieldEntity>();
  const docMetadataStore = new Map<string, Record<string, DocumentMetadataValue>>();
  const auditEvents: AuditEventRecord[] = [];
  let seq = 0;

  const categories: CategoryRepositoryPort = {
    async findById(id: string): Promise<CategoryEntity | null> {
      return categoryStore.get(id) ?? null;
    },
    async findByName(): Promise<CategoryEntity | null> {
      return null;
    },
    async countExistingDocuments(): Promise<number> {
      return docMetadataStore.size;
    },
    async listAuthorized(
      filter: CategoryListFilter,
      _scope: AuthorizedCategoryQueryScope,
    ): Promise<PaginatedResult<CategoryEntity>> {
      return {
        items: [],
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: 0,
        totalPages: 0,
      };
    },
    async create(input: CreateCategoryInput): Promise<CategoryEntity> {
      const now = new Date().toISOString();
      return {
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
    },
    async update(_input: UpdateCategoryInput): Promise<CategoryEntity | null> {
      return null;
    },
    async listFields(catId: string): Promise<readonly CategoryFieldEntity[]> {
      return [...fieldStore.values()]
        .filter((f) => f.categoryId === catId)
        .sort((a, b) => a.sortOrder - b.sortOrder);
    },
    async findFieldById(catId: string, fieldId: string): Promise<CategoryFieldEntity | null> {
      const found = fieldStore.get(fieldId);
      return found && found.categoryId === catId ? found : null;
    },
    async findFieldByKey(catId: string, key: string): Promise<CategoryFieldEntity | null> {
      for (const field of fieldStore.values()) {
        if (field.categoryId === catId && field.key === key) {
          return field;
        }
      }
      return null;
    },
    async createField(input: CreateCategoryFieldRecordInput): Promise<CategoryFieldEntity> {
      const now = new Date().toISOString();
      const entity: CategoryFieldEntity = {
        ...input,
        createdAt: now,
        updatedAt: now,
      };
      fieldStore.set(entity.id, entity);
      return entity;
    },
    async updateField(input: UpdateCategoryFieldRecordInput): Promise<CategoryFieldEntity | null> {
      const existing = fieldStore.get(input.id);
      if (!existing || existing.categoryId !== input.categoryId) {
        return null;
      }
      const updated: CategoryFieldEntity = {
        ...existing,
        label: input.label ?? existing.label,
        type: input.type ?? existing.type,
        required: input.required ?? existing.required,
        options: input.options !== undefined ? input.options : existing.options,
        sortOrder: input.sortOrder ?? existing.sortOrder,
        updatedAt: new Date().toISOString(),
      };
      fieldStore.set(updated.id, updated);
      return updated;
    },
    async deleteField(catId: string, fieldId: string): Promise<boolean> {
      const existing = fieldStore.get(fieldId);
      if (!existing || existing.categoryId !== catId) {
        return false;
      }
      fieldStore.delete(fieldId);
      return true;
    },
    async listExistingDocumentMetadata(): Promise<readonly ExistingDocumentMetadataSnapshot[]> {
      return [...docMetadataStore.entries()].map(([documentId, metadata]) => ({
        documentId,
        metadata: metadata as DocumentMetadataMap,
      }));
    },
    async backfillFieldMetadata(input): Promise<void> {
      for (const meta of docMetadataStore.values()) {
        if (meta[input.fieldKey] === undefined || meta[input.fieldKey] === null) {
          meta[input.fieldKey] = input.defaultValue;
        }
      }
    },
    async resetFieldMetadata(input): Promise<void> {
      for (const meta of docMetadataStore.values()) {
        meta[input.fieldKey] = input.defaultValue;
      }
    },
    async removeFieldMetadata(input): Promise<void> {
      for (const meta of docMetadataStore.values()) {
        delete meta[input.fieldKey];
      }
    },
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

  const service = createCategoryFieldService({
    categories,
    transactions,
    audit,
    generateId: () => `field-${++seq}`,
  });

  return { service, docMetadataStore, categoryId, organizationId, auditEvents };
}

describe("CategoryFieldService", () => {
  it("rejects incompatible additions, type changes, option removals and deletes without migration strategy", async () => {
    const { service, docMetadataStore, categoryId, organizationId } = createInMemoryFieldHarness();

    const statusField = await service.addField({
      organizationId,
      actorUserId: "user-1",
      requestId: "req-1",
      categoryId,
      key: "prioridade",
      label: "Prioridade",
      type: "SINGLE_SELECT",
      required: false,
      options: ["BAIXA", "MEDIA", "ALTA"],
      sortOrder: 0,
    });

    docMetadataStore.set("doc-1", { prioridade: "ALTA" });

    // Adding required field with existing docs without strategy is blocked
    await expect(
      service.addField({
        organizationId,
        actorUserId: "user-1",
        requestId: "req-2",
        categoryId,
        key: "fornecedor",
        label: "Fornecedor",
        type: "TEXT",
        required: true,
      }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_CATEGORY_FIELD_CHANGE" });

    // Adding required field with BACKFILL_DEFAULT migrates existing docs
    const vendorField = await service.addField({
      organizationId,
      actorUserId: "user-1",
      requestId: "req-3",
      categoryId,
      key: "fornecedor",
      label: "Fornecedor",
      type: "TEXT",
      required: true,
      migrationStrategy: { type: "BACKFILL_DEFAULT", defaultValue: "Não informado" },
    });
    expect(docMetadataStore.get("doc-1")?.fornecedor).toBe("Não informado");

    // Removing an option still used by doc-1 fails without RESET_TO_DEFAULT
    await expect(
      service.updateField({
        organizationId,
        actorUserId: "user-1",
        requestId: "req-4",
        categoryId,
        fieldId: statusField.id,
        options: ["BAIXA", "MEDIA"],
      }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_CATEGORY_FIELD_CHANGE" });

    // Succeeds with RESET_TO_DEFAULT
    await service.updateField({
      organizationId,
      actorUserId: "user-1",
      requestId: "req-5",
      categoryId,
      fieldId: statusField.id,
      options: ["BAIXA", "MEDIA"],
      migrationStrategy: { type: "RESET_TO_DEFAULT", defaultValue: "MEDIA" },
    });
    expect(docMetadataStore.get("doc-1")?.prioridade).toBe("MEDIA");

    // Changing TEXT -> NUMBER with BACKFILL_DEFAULT fails (incompatible non-null values), requires RESET_TO_DEFAULT
    await expect(
      service.updateField({
        organizationId,
        actorUserId: "user-1",
        requestId: "req-6",
        categoryId,
        fieldId: vendorField.id,
        type: "NUMBER",
        migrationStrategy: { type: "BACKFILL_DEFAULT", defaultValue: 0 },
      }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_CATEGORY_FIELD_CHANGE" });

    await service.updateField({
      organizationId,
      actorUserId: "user-1",
      requestId: "req-7",
      categoryId,
      fieldId: vendorField.id,
      type: "NUMBER",
      migrationStrategy: { type: "RESET_TO_DEFAULT", defaultValue: 100 },
    });
    expect(docMetadataStore.get("doc-1")?.fornecedor).toBe(100);

    // Deleting field with existing docs fails without REMOVE_FROM_DOCUMENTS
    await expect(
      service.removeField({
        organizationId,
        actorUserId: "user-1",
        requestId: "req-8",
        categoryId,
        fieldId: vendorField.id,
      }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_CATEGORY_FIELD_CHANGE" });

    await service.removeField({
      organizationId,
      actorUserId: "user-1",
      requestId: "req-9",
      categoryId,
      fieldId: vendorField.id,
      migrationStrategy: { type: "REMOVE_FROM_DOCUMENTS" },
    });
    expect("fornecedor" in (docMetadataStore.get("doc-1") ?? {})).toBe(false);
  });
});
