import type {
  ArchiveFolderInput,
  AuthorizedFolderQueryScope,
  CreateFolderInput,
  FolderEntity,
  FolderListFilter,
  FolderRepositoryPort,
  FolderSortField,
  MoveFolderSubtreeInput,
  PaginatedResult,
  RenameFolderInput,
  TransactionContext,
} from "@docuflow/domain";
import {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  not,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { folders } from "../schema/taxonomy.js";
import { resolveDbExecutor } from "./transaction-manager.js";

const ALLOWED_FOLDER_SORT_COLUMNS: Readonly<
  Record<
    FolderSortField,
    | typeof folders.name
    | typeof folders.status
    | typeof folders.createdAt
    | typeof folders.updatedAt
    | typeof folders.id
  >
> = {
  name: folders.name,
  status: folders.status,
  createdAt: folders.createdAt,
  updatedAt: folders.updatedAt,
  id: folders.id,
};

function toFolderEntity(row: typeof folders.$inferSelect): FolderEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    parentId: row.parentId,
    name: row.name,
    materializedPath: row.materializedPath,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function expandSubtreeFolderIds(
  db: NodePgDatabase,
  organizationId: string,
  rootFolderIds: readonly string[],
): Promise<readonly string[]> {
  if (rootFolderIds.length === 0) {
    return [];
  }

  const expanded = new Set<string>();
  const queue = [...rootFolderIds];

  while (queue.length > 0) {
    const batch = queue.splice(0, queue.length);
    const unvisited = batch.filter((id) => !expanded.has(id));
    if (unvisited.length === 0) {
      continue;
    }

    for (const id of unvisited) {
      expanded.add(id);
    }

    const childRows = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.organizationId, organizationId), inArray(folders.parentId, unvisited)));

    for (const child of childRows) {
      if (!expanded.has(child.id)) {
        queue.push(child.id);
      }
    }
  }

  return Array.from(expanded);
}

/**
 * Creates the Drizzle ORM folder repository supporting hierarchy queries and atomic subtree moves.
 */
export function createFolderRepository(db: NodePgDatabase): FolderRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<FolderEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor.select().from(folders).where(eq(folders.id, id)).limit(1);
      return row ? toFolderEntity(row) : null;
    },

    async findByNameInParent(
      organizationId: string,
      parentId: string | null,
      name: string,
      tx?: TransactionContext,
    ): Promise<FolderEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const parentCondition =
        parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId);
      const [row] = await executor
        .select()
        .from(folders)
        .where(
          and(eq(folders.organizationId, organizationId), parentCondition, eq(folders.name, name)),
        )
        .limit(1);
      return row ? toFolderEntity(row) : null;
    },

    async listAncestorIds(
      organizationId: string,
      folderId: string,
      tx?: TransactionContext,
    ): Promise<readonly string[]> {
      const executor = resolveDbExecutor(db, tx);
      const ancestors: string[] = [];
      const visited = new Set<string>([folderId]);
      let currentId: string | null = folderId;

      while (currentId !== null) {
        const rows: ReadonlyArray<{ parentId: string | null }> = await executor
          .select({ parentId: folders.parentId })
          .from(folders)
          .where(and(eq(folders.id, currentId), eq(folders.organizationId, organizationId)))
          .limit(1);

        const nextParentId = rows[0]?.parentId ?? null;
        if (!nextParentId || visited.has(nextParentId)) {
          break;
        }
        visited.add(nextParentId);
        ancestors.push(nextParentId);
        currentId = nextParentId;
      }

      return ancestors;
    },

    async hasActiveChildren(
      organizationId: string,
      folderId: string,
      tx?: TransactionContext,
    ): Promise<boolean> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({ total: count() })
        .from(folders)
        .where(
          and(
            eq(folders.organizationId, organizationId),
            eq(folders.parentId, folderId),
            eq(folders.status, "ACTIVE"),
          ),
        );
      return Number(row?.total ?? 0) > 0;
    },

    async listAuthorized(
      filter: FolderListFilter,
      scope: AuthorizedFolderQueryScope,
    ): Promise<PaginatedResult<FolderEntity>> {
      const emptyResult: PaginatedResult<FolderEntity> = {
        items: [],
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: 0,
        totalPages: 0,
      };

      const hasAnyAllow = scope.hasGlobalAllow || scope.allowedFolderIds.length > 0;
      if (scope.hasGlobalDeny || !hasAnyAllow) {
        return emptyResult;
      }

      const [expandedAllowedIds, expandedDeniedIds] = await Promise.all([
        expandSubtreeFolderIds(db, filter.organizationId, scope.allowedFolderIds),
        expandSubtreeFolderIds(db, filter.organizationId, scope.deniedFolderIds),
      ]);

      if (!scope.hasGlobalAllow && expandedAllowedIds.length === 0) {
        return emptyResult;
      }

      const conditions: SQL[] = [eq(folders.organizationId, filter.organizationId)];

      if (filter.parentId === null) {
        conditions.push(isNull(folders.parentId));
      } else if (filter.parentId !== undefined) {
        conditions.push(eq(folders.parentId, filter.parentId));
      }

      if (filter.status !== undefined) {
        conditions.push(eq(folders.status, filter.status));
      }

      if (filter.search !== undefined && filter.search.trim().length > 0) {
        conditions.push(ilike(folders.name, `%${filter.search.trim()}%`));
      }

      if (!scope.hasGlobalAllow) {
        conditions.push(inArray(folders.id, [...expandedAllowedIds]));
      }

      if (expandedDeniedIds.length > 0) {
        conditions.push(not(inArray(folders.id, [...expandedDeniedIds])));
      }

      const whereClause = and(...conditions);
      const sortColumn = ALLOWED_FOLDER_SORT_COLUMNS[filter.sortBy];
      const primaryOrder = filter.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
      const tiebreakerOrder = filter.sortDirection === "asc" ? asc(folders.id) : desc(folders.id);
      const offset = (filter.page - 1) * filter.pageSize;

      const [countRow] = await db.select({ total: count() }).from(folders).where(whereClause);
      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);

      const rows = await db
        .select()
        .from(folders)
        .where(whereClause)
        .orderBy(primaryOrder, tiebreakerOrder)
        .limit(filter.pageSize)
        .offset(offset);

      return {
        items: rows.map(toFolderEntity),
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages,
      };
    },

    async create(input: CreateFolderInput, tx?: TransactionContext): Promise<FolderEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(folders)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          parentId: input.parentId,
          name: input.name,
          materializedPath: input.materializedPath,
          status: "ACTIVE",
          createdBy: input.createdBy,
          updatedBy: input.createdBy,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to insert folder record.");
      }

      return toFolderEntity(row);
    },

    async rename(input: RenameFolderInput, tx?: TransactionContext): Promise<FolderEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .update(folders)
        .set({
          name: input.name,
          updatedBy: input.updatedBy,
          updatedAt: new Date(),
        })
        .where(and(eq(folders.id, input.id), eq(folders.organizationId, input.organizationId)))
        .returning();

      return row ? toFolderEntity(row) : null;
    },

    async moveSubtree(
      input: MoveFolderSubtreeInput,
      tx?: TransactionContext,
    ): Promise<FolderEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const now = new Date();
      const [movedRoot] = await executor
        .update(folders)
        .set({
          parentId: input.newParentId,
          materializedPath: input.newMaterializedPath,
          updatedBy: input.updatedBy,
          updatedAt: now,
        })
        .where(
          and(eq(folders.id, input.folderId), eq(folders.organizationId, input.organizationId)),
        )
        .returning();

      if (!movedRoot) {
        return null;
      }

      const descendantPrefix = `${input.oldMaterializedPath}/`;
      const oldPrefixLen = input.oldMaterializedPath.length;

      await executor
        .update(folders)
        .set({
          materializedPath: sql`${input.newMaterializedPath} || substr(${folders.materializedPath}, ${oldPrefixLen + 1})`,
          updatedBy: input.updatedBy,
          updatedAt: now,
        })
        .where(
          and(
            eq(folders.organizationId, input.organizationId),
            ne(folders.id, input.folderId),
            sql`left(${folders.materializedPath}, ${descendantPrefix.length}) = ${descendantPrefix}`,
          ),
        );

      return toFolderEntity(movedRoot);
    },

    async archive(
      input: ArchiveFolderInput,
      tx?: TransactionContext,
    ): Promise<FolderEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .update(folders)
        .set({
          status: "ARCHIVED",
          updatedBy: input.updatedBy,
          updatedAt: new Date(),
        })
        .where(and(eq(folders.id, input.id), eq(folders.organizationId, input.organizationId)))
        .returning();

      return row ? toFolderEntity(row) : null;
    },
  };
}
