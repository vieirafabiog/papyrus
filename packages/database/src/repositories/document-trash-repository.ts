import {
  DEFAULT_TRASH_GRACE_DAYS,
  type DocumentStatus,
  type PaginatedResult,
  evaluateTrashRestoreWindow,
} from "@papyrus/domain";
import { type SQL, and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documents } from "../schema/documents.js";
import { retentionPolicies } from "../schema/governance.js";
import { users } from "../schema/identity.js";
import { categories } from "../schema/taxonomy.js";
import type { AuthorizedDocumentQueryScope } from "./authorization-repository.js";
import {
  buildAuthorizedDocumentScopeConditions,
  expandFolderSubtreeIds,
} from "./authorized-scope-sql.js";

export type DocumentTrashSortField = "deletedAt" | "title" | "updatedAt";

export interface DocumentTrashFilter {
  readonly organizationId: string;
  readonly search?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly folderId?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: DocumentTrashSortField;
  readonly sortDirection: "asc" | "desc";
  readonly referenceNow?: Date | undefined;
  readonly fallbackTrashGraceDays?: number | undefined;
}

export interface DocumentTrashListItemRecord {
  readonly id: string;
  readonly title: string;
  readonly categoryId: string;
  readonly categoryName: string | null;
  readonly folderId: string | null;
  readonly status: DocumentStatus;
  readonly currentVersionId: string | null;
  readonly ownerUserId: string;
  readonly ownerName: string | null;
  readonly issueDate: string | null;
  readonly expirationDate: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly trashGraceDays: number;
  readonly restoreDeadlineAt: string | null;
  readonly canRestore: boolean;
}

export interface DocumentTrashRepository {
  listAuthorizedTrash(
    filter: DocumentTrashFilter,
    scope: AuthorizedDocumentQueryScope,
  ): Promise<PaginatedResult<DocumentTrashListItemRecord>>;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function resolveTrashOrderColumns(
  sortBy: DocumentTrashSortField,
  sortDirection: "asc" | "desc",
): readonly SQL[] {
  const isAsc = sortDirection === "asc";
  const dir = isAsc ? asc : desc;
  const tiebreaker = dir(documents.id);

  switch (sortBy) {
    case "title":
      return [dir(documents.title), tiebreaker];
    case "updatedAt":
      return [dir(documents.updatedAt), tiebreaker];
    default:
      return [
        isAsc
          ? sql`${documents.deletedAt} ASC NULLS LAST`
          : sql`${documents.deletedAt} DESC NULLS LAST`,
        tiebreaker,
      ];
  }
}

/**
 * PostgreSQL repository for authorized trash listing and restore-window status,
 * applying tenant isolation and ALLOW/DENY scope predicates before counts and pagination.
 */
export function createDocumentTrashRepository(db: NodePgDatabase): DocumentTrashRepository {
  return {
    async listAuthorizedTrash(
      filter: DocumentTrashFilter,
      scope: AuthorizedDocumentQueryScope,
    ): Promise<PaginatedResult<DocumentTrashListItemRecord>> {
      const [expandedAllowedFolders, expandedDeniedFolders] = await Promise.all([
        expandFolderSubtreeIds(db, filter.organizationId, scope.allowedFolderIds),
        expandFolderSubtreeIds(db, filter.organizationId, scope.deniedFolderIds),
      ]);

      const scopeResult = buildAuthorizedDocumentScopeConditions(
        scope,
        expandedAllowedFolders,
        expandedDeniedFolders,
      );

      if (!scopeResult.allowed) {
        return {
          items: [],
          page: filter.page,
          pageSize: filter.pageSize,
          totalItems: 0,
          totalPages: 0,
        };
      }

      const conditions: SQL[] = [
        eq(documents.organizationId, filter.organizationId),
        eq(documents.status, "DELETED"),
        ...scopeResult.conditions,
      ];

      if (filter.search && filter.search.trim().length > 0) {
        const pattern = `%${escapeLikePattern(filter.search.trim())}%`;
        conditions.push(ilike(documents.title, pattern));
      }

      if (filter.categoryId) {
        conditions.push(eq(documents.categoryId, filter.categoryId));
      }

      if (filter.folderId) {
        const subtreeIds = await expandFolderSubtreeIds(db, filter.organizationId, [
          filter.folderId,
        ]);
        if (subtreeIds.length > 0) {
          conditions.push(inArray(documents.folderId, [...subtreeIds]));
        } else {
          conditions.push(eq(documents.folderId, filter.folderId));
        }
      }

      const whereClause = and(...conditions);
      const offset = (filter.page - 1) * filter.pageSize;
      const orderColumns = resolveTrashOrderColumns(filter.sortBy, filter.sortDirection);

      const [totalRowResult, rows, activePolicies] = await Promise.all([
        db.select({ total: count() }).from(documents).where(whereClause),
        db
          .select({
            id: documents.id,
            title: documents.title,
            categoryId: documents.categoryId,
            categoryName: categories.name,
            folderId: documents.folderId,
            status: documents.status,
            currentVersionId: documents.currentVersionId,
            ownerUserId: documents.ownerUserId,
            ownerName: users.fullName,
            issueDate: documents.issueDate,
            expirationDate: documents.expirationDate,
            version: documents.version,
            createdAt: documents.createdAt,
            updatedAt: documents.updatedAt,
            deletedAt: documents.deletedAt,
          })
          .from(documents)
          .leftJoin(categories, eq(categories.id, documents.categoryId))
          .leftJoin(users, eq(users.id, documents.ownerUserId))
          .where(whereClause)
          .orderBy(...orderColumns)
          .limit(filter.pageSize)
          .offset(offset),
        db
          .select({
            categoryId: retentionPolicies.categoryId,
            trashGraceDays: retentionPolicies.trashGraceDays,
          })
          .from(retentionPolicies)
          .where(
            and(
              eq(retentionPolicies.organizationId, filter.organizationId),
              eq(retentionPolicies.isActive, true),
            ),
          )
          .orderBy(asc(retentionPolicies.createdAt), asc(retentionPolicies.id)),
      ]);

      const globalPolicy = activePolicies.find((policy) => policy.categoryId === null) ?? null;
      const categoryPolicyById = new Map<string, number>();
      for (const policy of activePolicies) {
        if (policy.categoryId !== null && !categoryPolicyById.has(policy.categoryId)) {
          categoryPolicyById.set(policy.categoryId, policy.trashGraceDays);
        }
      }

      const referenceNow = filter.referenceNow ?? new Date();
      const fallbackGraceDays = filter.fallbackTrashGraceDays ?? DEFAULT_TRASH_GRACE_DAYS;
      const totalItems = Number(totalRowResult[0]?.total ?? 0);

      const items: DocumentTrashListItemRecord[] = rows.map((row) => {
        const policyGraceDays =
          categoryPolicyById.get(row.categoryId) ??
          globalPolicy?.trashGraceDays ??
          fallbackGraceDays;
        const windowResult = evaluateTrashRestoreWindow({
          deletedAt: row.deletedAt,
          graceDays: policyGraceDays,
          referenceNow,
        });

        return {
          id: row.id,
          title: row.title,
          categoryId: row.categoryId,
          categoryName: row.categoryName ?? null,
          folderId: row.folderId,
          status: row.status,
          currentVersionId: row.currentVersionId,
          ownerUserId: row.ownerUserId,
          ownerName: row.ownerName ?? null,
          issueDate: row.issueDate,
          expirationDate: row.expirationDate,
          version: row.version,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
          trashGraceDays: windowResult.graceDays,
          restoreDeadlineAt: windowResult.restoreDeadlineAt
            ? windowResult.restoreDeadlineAt.toISOString()
            : null,
          canRestore: windowResult.canRestore,
        };
      });

      return {
        items,
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize),
      };
    },
  };
}
