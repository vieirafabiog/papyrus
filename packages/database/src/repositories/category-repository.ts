import type {
  AuthorizedCategoryQueryScope,
  CategoryEntity,
  CategoryListFilter,
  CategoryRepositoryPort,
  CategorySortField,
  CreateCategoryInput,
  PaginatedResult,
  TransactionContext,
  UpdateCategoryInput,
} from "@docuflow/domain";
import { type SQL, and, asc, count, desc, eq, ilike, inArray, ne, not } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documents } from "../schema/documents.js";
import { categories } from "../schema/taxonomy.js";
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Creates the Drizzle ORM category repository with scoped listing and document-link checks.
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

      const [row] = await executor
        .update(categories)
        .set(updateSet)
        .where(
          and(eq(categories.id, input.id), eq(categories.organizationId, input.organizationId)),
        )
        .returning();

      return row ? toCategoryEntity(row) : null;
    },
  };
}
