import {
  DEFAULT_EXPIRATION_TIMEZONE,
  type DocumentExpirationBucket,
  type DocumentExpirationState,
  type DocumentStatus,
  type PaginatedResult,
  addCalendarDays,
  classifyExpirationState,
  diffCalendarDays,
  isValidIanaTimeZone,
  resolveLocalCalendarDate,
} from "@papyrus/domain";
import {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documentVersions, documents } from "../schema/documents.js";
import { organizations, users } from "../schema/identity.js";
import { fileObjects } from "../schema/storage.js";
import { categories } from "../schema/taxonomy.js";
import type { AuthorizedDocumentQueryScope } from "./authorization-repository.js";
import {
  buildAuthorizedDocumentScopeConditions,
  expandFolderSubtreeIds,
} from "./authorized-scope-sql.js";

export type DocumentExpirationSortField = "expirationDate" | "title" | "status" | "updatedAt";

export interface DocumentExpirationsFilter {
  readonly organizationId: string;
  readonly bucket: DocumentExpirationBucket;
  readonly windowDays: number;
  readonly timezone?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly folderId?: string | undefined;
  readonly ownerUserId?: string | undefined;
  readonly search?: string | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: DocumentExpirationSortField;
  readonly sortDirection: "asc" | "desc";
  readonly referenceNow?: Date | undefined;
}

export interface DocumentExpirationListItemRecord {
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
  readonly expirationState: DocumentExpirationState;
  readonly daysUntilExpiration: number | null;
}

export interface DocumentExpirationsSummaryRecord {
  readonly expiredCount: number;
  readonly expiringSoonCount: number;
  readonly upToDateCount: number;
  readonly noExpirationCount: number;
}

export interface DocumentExpirationsQueryResult {
  readonly list: PaginatedResult<DocumentExpirationListItemRecord>;
  readonly summary: DocumentExpirationsSummaryRecord;
  readonly timezone: string;
  readonly referenceDate: string;
  readonly windowDays: number;
}

export interface DocumentExpirationRepository {
  listAuthorizedExpirations(
    filter: DocumentExpirationsFilter,
    scope: AuthorizedDocumentQueryScope,
  ): Promise<DocumentExpirationsQueryResult>;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function resolveBucketCondition(
  bucket: DocumentExpirationBucket,
  referenceIsoDate: string,
  windowEndIsoDate: string,
): SQL | null {
  switch (bucket) {
    case "EXPIRED":
      return (
        and(isNotNull(documents.expirationDate), lt(documents.expirationDate, referenceIsoDate)) ??
        null
      );
    case "EXPIRING_SOON":
      return (
        and(
          isNotNull(documents.expirationDate),
          gte(documents.expirationDate, referenceIsoDate),
          lte(documents.expirationDate, windowEndIsoDate),
        ) ?? null
      );
    case "UP_TO_DATE":
      return (
        and(isNotNull(documents.expirationDate), gt(documents.expirationDate, windowEndIsoDate)) ??
        null
      );
    case "NO_DATE":
      return isNull(documents.expirationDate);
    default:
      return null;
  }
}

function resolveExpirationOrderColumns(
  sortBy: DocumentExpirationSortField,
  sortDirection: "asc" | "desc",
): readonly SQL[] {
  const isAsc = sortDirection === "asc";
  const dir = isAsc ? asc : desc;
  const tiebreaker = dir(documents.id);

  switch (sortBy) {
    case "title":
      return [dir(documents.title), tiebreaker];
    case "status":
      return [dir(documents.status), tiebreaker];
    case "updatedAt":
      return [dir(documents.updatedAt), tiebreaker];
    default:
      return [
        isAsc
          ? sql`${documents.expirationDate} ASC NULLS LAST`
          : sql`${documents.expirationDate} DESC NULLS LAST`,
        tiebreaker,
      ];
  }
}

/**
 * PostgreSQL repository for authorized expiration tracking across overdue,
 * expiring soon, up-to-date, and undated documents respecting the organization's timezone.
 */
export function createDocumentExpirationRepository(
  db: NodePgDatabase,
): DocumentExpirationRepository {
  return {
    async listAuthorizedExpirations(
      filter: DocumentExpirationsFilter,
      scope: AuthorizedDocumentQueryScope,
    ): Promise<DocumentExpirationsQueryResult> {
      const [orgRow] = await db
        .select({ timezone: organizations.timezone })
        .from(organizations)
        .where(eq(organizations.id, filter.organizationId))
        .limit(1);

      const effectiveTimezone =
        filter.timezone && isValidIanaTimeZone(filter.timezone)
          ? filter.timezone.trim()
          : orgRow?.timezone && isValidIanaTimeZone(orgRow.timezone)
            ? orgRow.timezone
            : DEFAULT_EXPIRATION_TIMEZONE;

      const referenceDate = resolveLocalCalendarDate(
        filter.referenceNow ?? new Date(),
        effectiveTimezone,
      );
      const windowEndDate = addCalendarDays(referenceDate, filter.windowDays);

      const emptyResult: DocumentExpirationsQueryResult = {
        list: {
          items: [],
          page: filter.page,
          pageSize: filter.pageSize,
          totalItems: 0,
          totalPages: 0,
        },
        summary: {
          expiredCount: 0,
          expiringSoonCount: 0,
          upToDateCount: 0,
          noExpirationCount: 0,
        },
        timezone: effectiveTimezone,
        referenceDate,
        windowDays: filter.windowDays,
      };

      const hasAnyAllow =
        scope.hasGlobalAllow ||
        scope.allowedCategoryIds.length > 0 ||
        scope.allowedFolderIds.length > 0 ||
        scope.allowedDocumentIds.length > 0;

      if (scope.hasGlobalDeny || !hasAnyAllow) {
        return emptyResult;
      }

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
        return emptyResult;
      }

      const baseConditions: SQL[] = [
        eq(documents.organizationId, filter.organizationId),
        ne(documents.status, "DELETED"),
        ...scopeResult.conditions,
      ];

      if (!filter.includeArchived) {
        baseConditions.push(ne(documents.status, "ARCHIVED"));
      }
      if (filter.categoryId !== undefined) {
        baseConditions.push(eq(documents.categoryId, filter.categoryId));
      }
      if (filter.folderId !== undefined) {
        baseConditions.push(eq(documents.folderId, filter.folderId));
      }
      if (filter.ownerUserId !== undefined) {
        baseConditions.push(eq(documents.ownerUserId, filter.ownerUserId));
      }
      if (filter.search !== undefined && filter.search.trim().length > 0) {
        const pattern = `%${escapeLikePattern(filter.search.trim())}%`;
        const matchingFileVersions = db
          .select({ versionId: documentVersions.id })
          .from(documentVersions)
          .innerJoin(fileObjects, eq(documentVersions.fileObjectId, fileObjects.id))
          .where(
            and(
              eq(fileObjects.organizationId, filter.organizationId),
              ilike(fileObjects.originalFileName, pattern),
            ),
          );
        const searchPredicate = or(
          ilike(documents.title, pattern),
          inArray(documents.currentVersionId, matchingFileVersions),
        );
        if (searchPredicate) {
          baseConditions.push(searchPredicate);
        }
      }

      const baseWhere = and(...baseConditions);

      const [summaryRow] = await db
        .select({
          expiredCount: sql<number>`count(*) FILTER (WHERE ${documents.expirationDate} IS NOT NULL AND ${documents.expirationDate} < ${referenceDate})::int`,
          expiringSoonCount: sql<number>`count(*) FILTER (WHERE ${documents.expirationDate} IS NOT NULL AND ${documents.expirationDate} >= ${referenceDate} AND ${documents.expirationDate} <= ${windowEndDate})::int`,
          upToDateCount: sql<number>`count(*) FILTER (WHERE ${documents.expirationDate} IS NOT NULL AND ${documents.expirationDate} > ${windowEndDate})::int`,
          noExpirationCount: sql<number>`count(*) FILTER (WHERE ${documents.expirationDate} IS NULL)::int`,
        })
        .from(documents)
        .where(baseWhere);

      const bucketCondition = resolveBucketCondition(filter.bucket, referenceDate, windowEndDate);
      const listConditions = bucketCondition
        ? [...baseConditions, bucketCondition]
        : baseConditions;
      const listWhere = and(...listConditions);
      const offset = (filter.page - 1) * filter.pageSize;

      const [countRow] = await db.select({ total: count() }).from(documents).where(listWhere);
      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);

      const rows = await db
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
        })
        .from(documents)
        .leftJoin(categories, eq(documents.categoryId, categories.id))
        .leftJoin(users, eq(documents.ownerUserId, users.id))
        .where(listWhere)
        .orderBy(...resolveExpirationOrderColumns(filter.sortBy, filter.sortDirection))
        .limit(filter.pageSize)
        .offset(offset);

      return {
        list: {
          items: rows.map((row) => ({
            id: row.id,
            title: row.title,
            categoryId: row.categoryId,
            categoryName: row.categoryName,
            folderId: row.folderId,
            status: row.status,
            currentVersionId: row.currentVersionId,
            ownerUserId: row.ownerUserId,
            ownerName: row.ownerName,
            issueDate: row.issueDate,
            expirationDate: row.expirationDate,
            version: row.version,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            expirationState: classifyExpirationState(
              row.expirationDate,
              referenceDate,
              filter.windowDays,
            ),
            daysUntilExpiration:
              row.expirationDate !== null
                ? diffCalendarDays(row.expirationDate, referenceDate)
                : null,
          })),
          page: filter.page,
          pageSize: filter.pageSize,
          totalItems,
          totalPages,
        },
        summary: {
          expiredCount: Number(summaryRow?.expiredCount ?? 0),
          expiringSoonCount: Number(summaryRow?.expiringSoonCount ?? 0),
          upToDateCount: Number(summaryRow?.upToDateCount ?? 0),
          noExpirationCount: Number(summaryRow?.noExpirationCount ?? 0),
        },
        timezone: effectiveTimezone,
        referenceDate,
        windowDays: filter.windowDays,
      };
    },
  };
}
