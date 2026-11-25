import type {
  AuthorizedCategoryQueryScope,
  CategoryEntity,
  CategoryFieldEntity,
  CategoryFieldType,
  CategoryListFilter,
  CategoryRepositoryPort,
  CategorySortField,
  CreateCategoryFieldRecordInput,
  CreateCategoryInput,
  DocumentMetadataMap,
  DocumentMetadataValue,
  ExistingDocumentMetadataSnapshot,
  PaginatedResult,
  TransactionContext,
  UpdateCategoryFieldRecordInput,
  UpdateCategoryInput,
} from "@papyrus/domain";
import { type SQL, and, asc, count, desc, eq, ilike, inArray, ne, not, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  type DocumentMetadataColumnValue,
  documentMetadata,
  documents,
} from "../schema/documents.js";
import { categories, categoryFields } from "../schema/taxonomy.js";
import {
  toMetadataJsonValue as toJsonColumnValue,
  toTypedMetadataColumns,
} from "./metadata-columns.js";
import { resolveDbExecutor } from "./transaction-manager.js";

const ALLOWED_CATEGORY_SORT_COLUMNS: Readonly<
  Record<
    CategorySortField,
    | typeof categories.name
    | typeof categories.isActive
    | typeof categories.createdAt
    | typeof categories.updatedAt
    | typeof categories.id
  >
> = {
  name: categories.name,
  isActive: categories.isActive,
  createdAt: categories.createdAt,
  updatedAt: categories.updatedAt,
  id: categories.id,
};

function toCategoryEntity(row: typeof categories.$inferSelect): CategoryEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    description: row.description,
    color: row.color,
    icon: row.icon,
    isActive: row.isActive,
    textIndexingMode: row.textIndexingMode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCategoryFieldEntity(row: typeof categoryFields.$inferSelect): CategoryFieldEntity {
  return {
    id: row.id,
    categoryId: row.categoryId,
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    options: row.options,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function applyMetadataMigrationForDocuments(
  db: NodePgDatabase,
  input: {
    readonly organizationId: string;
    readonly categoryId: string;
    readonly fieldId: string;
    readonly fieldKey: string;
    readonly fieldType: CategoryFieldType;
    readonly defaultValue: DocumentMetadataValue;
    readonly updatedBy: string;
    readonly onlyWhenMissingOrNull: boolean;
  },
  tx?: TransactionContext,
): Promise<void> {
  const executor = resolveDbExecutor(db, tx);
  const rows = await executor
    .select({ id: documents.id, metadata: documents.metadata })
    .from(documents)
    .where(
      and(
        eq(documents.organizationId, input.organizationId),
        eq(documents.categoryId, input.categoryId),
        ne(documents.status, "DELETED"),
      ),
    );

  const now = new Date();
  const typedCols = toTypedMetadataColumns(input.fieldType, input.defaultValue);

  for (const row of rows) {
    const existingValue = row.metadata[input.fieldKey];
    if (input.onlyWhenMissingOrNull && existingValue !== undefined && existingValue !== null) {
      continue;
    }

    const updatedMetadata: Record<string, DocumentMetadataColumnValue> = {
      ...row.metadata,
      [input.fieldKey]: toJsonColumnValue(input.defaultValue),
    };

    await executor
      .update(documents)
      .set({
        metadata: updatedMetadata,
        updatedBy: input.updatedBy,
        updatedAt: now,
      })
      .where(eq(documents.id, row.id));

    await executor
      .insert(documentMetadata)
      .values({
        documentId: row.id,
        fieldId: input.fieldId,
        fieldKey: input.fieldKey,
        ...typedCols,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [documentMetadata.documentId, documentMetadata.fieldId],
        set: {
          fieldKey: input.fieldKey,
          ...typedCols,
          updatedAt: now,
        },
      });
  }
}

/**
 * Creates the Drizzle ORM category repository with scoped listing, custom fields and metadata migration.
 */
export function createCategoryRepository(db: NodePgDatabase): CategoryRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<CategoryEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor.select().from(categories).where(eq(categories.id, id)).limit(1);
      return row ? toCategoryEntity(row) : null;
    },

    async findByName(
      organizationId: string,
      name: string,
      tx?: TransactionContext,
    ): Promise<CategoryEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(categories)
        .where(and(eq(categories.organizationId, organizationId), eq(categories.name, name)))
        .limit(1);
      return row ? toCategoryEntity(row) : null;
    },

    async countExistingDocuments(
      organizationId: string,
      categoryId: string,
      tx?: TransactionContext,
    ): Promise<number> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({ total: count() })
        .from(documents)
        .where(
          and(
            eq(documents.organizationId, organizationId),
            eq(documents.categoryId, categoryId),
            ne(documents.status, "DELETED"),
          ),
        );
      return Number(row?.total ?? 0);
    },

    async listAuthorized(
      filter: CategoryListFilter,
      scope: AuthorizedCategoryQueryScope,
    ): Promise<PaginatedResult<CategoryEntity>> {
      const emptyResult: PaginatedResult<CategoryEntity> = {
        items: [],
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: 0,
        totalPages: 0,
      };

      const hasAnyAllow = scope.hasGlobalAllow || scope.allowedCategoryIds.length > 0;
      if (scope.hasGlobalDeny || !hasAnyAllow) {
        return emptyResult;
      }

      const conditions: SQL[] = [eq(categories.organizationId, filter.organizationId)];

      if (filter.isActive !== undefined) {
        conditions.push(eq(categories.isActive, filter.isActive));
      }

      if (filter.search !== undefined && filter.search.trim().length > 0) {
        conditions.push(ilike(categories.name, `%${filter.search.trim()}%`));
      }

      if (!scope.hasGlobalAllow) {
        conditions.push(inArray(categories.id, [...scope.allowedCategoryIds]));
      }

      if (scope.deniedCategoryIds.length > 0) {
        conditions.push(not(inArray(categories.id, [...scope.deniedCategoryIds])));
      }

      const whereClause = and(...conditions);
      const sortColumn = ALLOWED_CATEGORY_SORT_COLUMNS[filter.sortBy];
      const primaryOrder = filter.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
      const tiebreakerOrder =
        filter.sortDirection === "asc" ? asc(categories.id) : desc(categories.id);
      const offset = (filter.page - 1) * filter.pageSize;

      const [countRow] = await db.select({ total: count() }).from(categories).where(whereClause);
      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);

      const rows = await db
        .select()
        .from(categories)
        .where(whereClause)
        .orderBy(primaryOrder, tiebreakerOrder)
        .limit(filter.pageSize)
        .offset(offset);

      return {
        items: rows.map(toCategoryEntity),
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages,
      };
    },

    async create(input: CreateCategoryInput, tx?: TransactionContext): Promise<CategoryEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(categories)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          name: input.name,
          description: input.description,
          color: input.color,
          icon: input.icon,
          isActive: true,
          ...(input.textIndexingMode !== undefined
            ? { textIndexingMode: input.textIndexingMode }
            : {}),
          createdBy: input.createdBy,
          updatedBy: input.createdBy,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to insert category record.");
      }
      return toCategoryEntity(row);
    },

    async update(
      input: UpdateCategoryInput,
      tx?: TransactionContext,
    ): Promise<CategoryEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const updateSet: Partial<typeof categories.$inferInsert> = {
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      };
      if (input.name !== undefined) {
        updateSet.name = input.name;
      }
      if (input.description !== undefined) {
        updateSet.description = input.description;
      }
      if (input.color !== undefined) {
        updateSet.color = input.color;
      }
      if (input.icon !== undefined) {
        updateSet.icon = input.icon;
      }
      if (input.isActive !== undefined) {
        updateSet.isActive = input.isActive;
      }
      if (input.textIndexingMode !== undefined) {
        updateSet.textIndexingMode = input.textIndexingMode;
      }

      const [row] = await executor
        .update(categories)
        .set(updateSet)
        .where(
          and(eq(categories.id, input.id), eq(categories.organizationId, input.organizationId)),
        )
        .returning();

      return row ? toCategoryEntity(row) : null;
    },

    async listFields(
      categoryId: string,
      tx?: TransactionContext,
    ): Promise<readonly CategoryFieldEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select()
        .from(categoryFields)
        .where(eq(categoryFields.categoryId, categoryId))
        .orderBy(asc(categoryFields.sortOrder), asc(categoryFields.key), asc(categoryFields.id));
      return rows.map(toCategoryFieldEntity);
    },

    async findFieldById(
      categoryId: string,
      fieldId: string,
      tx?: TransactionContext,
    ): Promise<CategoryFieldEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(categoryFields)
        .where(and(eq(categoryFields.categoryId, categoryId), eq(categoryFields.id, fieldId)))
        .limit(1);
      return row ? toCategoryFieldEntity(row) : null;
    },

    async findFieldByKey(
      categoryId: string,
      key: string,
      tx?: TransactionContext,
    ): Promise<CategoryFieldEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(categoryFields)
        .where(and(eq(categoryFields.categoryId, categoryId), eq(categoryFields.key, key)))
        .limit(1);
      return row ? toCategoryFieldEntity(row) : null;
    },

    async createField(
      input: CreateCategoryFieldRecordInput,
      tx?: TransactionContext,
    ): Promise<CategoryFieldEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(categoryFields)
        .values({
          id: input.id,
          categoryId: input.categoryId,
          key: input.key,
          label: input.label,
          type: input.type,
          required: input.required,
          options: input.options ? [...input.options] : null,
          sortOrder: input.sortOrder,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to insert category field record.");
      }
      return toCategoryFieldEntity(row);
    },

    async updateField(
      input: UpdateCategoryFieldRecordInput,
      tx?: TransactionContext,
    ): Promise<CategoryFieldEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const updateSet: Partial<typeof categoryFields.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.label !== undefined) {
        updateSet.label = input.label;
      }
      if (input.type !== undefined) {
        updateSet.type = input.type;
      }
      if (input.required !== undefined) {
        updateSet.required = input.required;
      }
      if (input.options !== undefined) {
        updateSet.options = input.options ? [...input.options] : null;
      }
      if (input.sortOrder !== undefined) {
        updateSet.sortOrder = input.sortOrder;
      }

      const [row] = await executor
        .update(categoryFields)
        .set(updateSet)
        .where(
          and(eq(categoryFields.id, input.id), eq(categoryFields.categoryId, input.categoryId)),
        )
        .returning();

      return row ? toCategoryFieldEntity(row) : null;
    },

    async deleteField(
      categoryId: string,
      fieldId: string,
      tx?: TransactionContext,
    ): Promise<boolean> {
      const executor = resolveDbExecutor(db, tx);
      await executor.delete(documentMetadata).where(eq(documentMetadata.fieldId, fieldId));
      const deletedRows = await executor
        .delete(categoryFields)
        .where(and(eq(categoryFields.categoryId, categoryId), eq(categoryFields.id, fieldId)))
        .returning({ id: categoryFields.id });
      return deletedRows.length > 0;
    },

    async listExistingDocumentMetadata(
      organizationId: string,
      categoryId: string,
      tx?: TransactionContext,
    ): Promise<readonly ExistingDocumentMetadataSnapshot[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select({
          documentId: documents.id,
          metadata: documents.metadata,
        })
        .from(documents)
        .where(
          and(
            eq(documents.organizationId, organizationId),
            eq(documents.categoryId, categoryId),
            ne(documents.status, "DELETED"),
          ),
        );

      return rows.map((row) => ({
        documentId: row.documentId,
        metadata: row.metadata as DocumentMetadataMap,
      }));
    },

    async backfillFieldMetadata(input, tx): Promise<void> {
      await applyMetadataMigrationForDocuments(db, { ...input, onlyWhenMissingOrNull: true }, tx);
    },

    async resetFieldMetadata(input, tx): Promise<void> {
      await applyMetadataMigrationForDocuments(db, { ...input, onlyWhenMissingOrNull: false }, tx);
    },

    async removeFieldMetadata(input, tx): Promise<void> {
      const executor = resolveDbExecutor(db, tx);
      await executor.delete(documentMetadata).where(eq(documentMetadata.fieldId, input.fieldId));
      await executor
        .update(documents)
        .set({
          metadata: sql`${documents.metadata} - ${input.fieldKey}`,
          updatedBy: input.updatedBy,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documents.organizationId, input.organizationId),
            eq(documents.categoryId, input.categoryId),
          ),
        );
    },
  };
}
