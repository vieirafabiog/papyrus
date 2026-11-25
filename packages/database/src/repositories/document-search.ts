import type {
  DocumentListItemEntity,
  DocumentSortField,
  DocumentStatus,
  PaginatedResult,
} from "@papyrus/domain";
import {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  documentExtractedTexts,
  documentMetadata,
  documentTags,
  documentVersions,
  documents,
} from "../schema/documents.js";
import { fileObjects } from "../schema/storage.js";
import type { AuthorizedDocumentQueryScope } from "./authorization-repository.js";
import {
  buildAuthorizedDocumentScopeConditions,
  expandFolderSubtreeIds,
} from "./authorized-scope-sql.js";

const ALLOWED_SEARCH_SORT_COLUMNS: Readonly<
  Record<
    DocumentSortField,
    | typeof documents.title
    | typeof documents.status
    | typeof documents.issueDate
    | typeof documents.expirationDate
    | typeof documents.createdAt
    | typeof documents.updatedAt
    | typeof documents.id
  >
> = {
  title: documents.title,
  status: documents.status,
  issueDate: documents.issueDate,
  expirationDate: documents.expirationDate,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  id: documents.id,
};

export type DocumentMetadataSearchFilter =
  | {
      readonly fieldKey: string;
      readonly type: "TEXT";
      readonly value: string;
      readonly matchMode?: "contains" | "exact" | undefined;
    }
  | {
      readonly fieldKey: string;
      readonly type: "SINGLE_SELECT";
      readonly value: string;
    }
  | {
      readonly fieldKey: string;
      readonly type: "NUMBER";
      readonly equals?: number | undefined;
      readonly min?: number | undefined;
      readonly max?: number | undefined;
    }
  | {
      readonly fieldKey: string;
      readonly type: "DATE";
      readonly equals?: string | undefined;
      readonly from?: string | undefined;
      readonly to?: string | undefined;
    }
  | {
      readonly fieldKey: string;
      readonly type: "BOOLEAN";
      readonly value: boolean;
    }
  | {
      readonly fieldKey: string;
      readonly type: "MULTI_SELECT";
      readonly values: readonly string[];
    };

export interface DocumentSearchFilter {
  readonly organizationId: string;
  readonly search?: string | undefined;
  readonly includeExtractedText?: boolean | undefined;
  readonly categoryId?: string | undefined;
  readonly folderId?: string | undefined;
  readonly rootOnly?: boolean | undefined;
  readonly includeSubfolders?: boolean | undefined;
  readonly status?: DocumentStatus | undefined;
  readonly authorUserId?: string | undefined;
  readonly ownerUserId?: string | undefined;
  readonly issueDateFrom?: string | undefined;
  readonly issueDateTo?: string | undefined;
  readonly expirationFrom?: string | undefined;
  readonly expirationTo?: string | undefined;
  readonly createdFrom?: string | undefined;
  readonly createdTo?: string | undefined;
  readonly updatedFrom?: string | undefined;
  readonly updatedTo?: string | undefined;
  readonly tagId?: string | undefined;
  readonly tagIds?: readonly string[] | undefined;
  readonly metadataFilters?: readonly DocumentMetadataSearchFilter[] | undefined;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: DocumentSortField;
  readonly sortDirection: "asc" | "desc";
}

export interface DocumentSearchRepository {
  searchAuthorizedDocuments(
    filter: DocumentSearchFilter,
    scope: AuthorizedDocumentQueryScope,
  ): Promise<PaginatedResult<DocumentListItemEntity>>;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toTimestampStart(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  return new Date(value);
}

function toTimestampEnd(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T23:59:59.999Z`);
  }
  return new Date(value);
}

function buildMetadataFilterCondition(
  db: NodePgDatabase,
  item: DocumentMetadataSearchFilter,
): SQL | null {
  const predicates: SQL[] = [eq(documentMetadata.fieldKey, item.fieldKey)];

  switch (item.type) {
    case "TEXT": {
      const normalized = item.value.trim();
      if (normalized.length === 0) {
        return null;
      }
      if (item.matchMode === "exact") {
        predicates.push(eq(documentMetadata.valueText, normalized));
      } else {
        predicates.push(ilike(documentMetadata.valueText, `%${escapeLikePattern(normalized)}%`));
      }
      break;
    }
    case "SINGLE_SELECT": {
      const normalized = item.value.trim();
      if (normalized.length === 0) {
        return null;
      }
      predicates.push(eq(documentMetadata.valueText, normalized));
      break;
    }
    case "NUMBER": {
      let hasNumberPredicate = false;
      if (item.equals !== undefined) {
        predicates.push(eq(documentMetadata.valueNumber, item.equals));
        hasNumberPredicate = true;
      }
      if (item.min !== undefined) {
        predicates.push(gte(documentMetadata.valueNumber, item.min));
        hasNumberPredicate = true;
      }
      if (item.max !== undefined) {
        predicates.push(lte(documentMetadata.valueNumber, item.max));
        hasNumberPredicate = true;
      }
      if (!hasNumberPredicate) {
        return null;
      }
      break;
    }
    case "DATE": {
      let hasDatePredicate = false;
      if (item.equals !== undefined) {
        predicates.push(eq(documentMetadata.valueDate, item.equals));
        hasDatePredicate = true;
      }
      if (item.from !== undefined) {
        predicates.push(gte(documentMetadata.valueDate, item.from));
        hasDatePredicate = true;
      }
      if (item.to !== undefined) {
        predicates.push(lte(documentMetadata.valueDate, item.to));
        hasDatePredicate = true;
      }
      if (!hasDatePredicate) {
        return null;
      }
      break;
    }
    case "BOOLEAN": {
      predicates.push(eq(documentMetadata.valueBoolean, item.value));
      break;
    }
    case "MULTI_SELECT": {
      const cleaned = item.values.map((v) => v.trim()).filter((v) => v.length > 0);
      if (cleaned.length === 0) {
        return null;
      }
      predicates.push(sql`${documentMetadata.valueJson} @> ${JSON.stringify(cleaned)}::jsonb`);
      break;
    }
  }

  const matchingDocIds = db
    .select({ documentId: documentMetadata.documentId })
    .from(documentMetadata)
    .where(and(...predicates));

  return inArray(documents.id, matchingDocIds);
}

export interface DocumentSearchRepositoryOptions {
  readonly enableExtractedTextSearch?: boolean | undefined;
  readonly ftsConfig?: "portuguese" | "simple" | "english" | undefined;
}

/**
 * Builds the advanced PostgreSQL document search repository, enforcing server-side
 * authorization scope before counting, sorting, and paginating results.
 */
export function createDocumentSearchRepository(
  db: NodePgDatabase,
  options: DocumentSearchRepositoryOptions = {},
): DocumentSearchRepository {
  const enableExtractedTextSearch = options.enableExtractedTextSearch ?? false;
  const ftsConfig = options.ftsConfig ?? "portuguese";
  return {
    async searchAuthorizedDocuments(
      filter: DocumentSearchFilter,
      scope: AuthorizedDocumentQueryScope,
    ): Promise<PaginatedResult<DocumentListItemEntity>> {
      const emptyResult: PaginatedResult<DocumentListItemEntity> = {
        items: [],
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: 0,
        totalPages: 0,
      };

      const hasAnyAllow =
        scope.hasGlobalAllow ||
        scope.allowedCategoryIds.length > 0 ||
        scope.allowedFolderIds.length > 0 ||
        scope.allowedDocumentIds.length > 0;

      if (scope.hasGlobalDeny || !hasAnyAllow || filter.status === "DELETED") {
        return emptyResult;
      }

      const [expandedAllowedFolders, expandedDeniedFolders, expandedFilterFolders] =
        await Promise.all([
          expandFolderSubtreeIds(db, filter.organizationId, scope.allowedFolderIds),
          expandFolderSubtreeIds(db, filter.organizationId, scope.deniedFolderIds),
          filter.folderId !== undefined && filter.includeSubfolders
            ? expandFolderSubtreeIds(db, filter.organizationId, [filter.folderId])
            : Promise.resolve([] as readonly string[]),
        ]);

      const conditions: SQL[] = [
        eq(documents.organizationId, filter.organizationId),
        ne(documents.status, "DELETED"),
      ];

      if (filter.status !== undefined) {
        conditions.push(eq(documents.status, filter.status));
      }
      if (filter.categoryId !== undefined) {
        conditions.push(eq(documents.categoryId, filter.categoryId));
      }
      if (filter.folderId !== undefined) {
        if (filter.includeSubfolders) {
          const targets =
            expandedFilterFolders.length > 0 ? [...expandedFilterFolders] : [filter.folderId];
          conditions.push(inArray(documents.folderId, targets));
        } else {
          conditions.push(eq(documents.folderId, filter.folderId));
        }
      } else if (filter.rootOnly) {
        conditions.push(isNull(documents.folderId));
      }
      if (filter.authorUserId !== undefined) {
        conditions.push(eq(documents.createdBy, filter.authorUserId));
      }
      if (filter.ownerUserId !== undefined) {
        conditions.push(eq(documents.ownerUserId, filter.ownerUserId));
      }
      if (filter.issueDateFrom !== undefined) {
        conditions.push(gte(documents.issueDate, filter.issueDateFrom));
      }
      if (filter.issueDateTo !== undefined) {
        conditions.push(lte(documents.issueDate, filter.issueDateTo));
      }
      if (filter.expirationFrom !== undefined) {
        conditions.push(gte(documents.expirationDate, filter.expirationFrom));
      }
      if (filter.expirationTo !== undefined) {
        conditions.push(lte(documents.expirationDate, filter.expirationTo));
      }
      if (filter.createdFrom !== undefined) {
        conditions.push(gte(documents.createdAt, toTimestampStart(filter.createdFrom)));
      }
      if (filter.createdTo !== undefined) {
        conditions.push(lte(documents.createdAt, toTimestampEnd(filter.createdTo)));
      }
      if (filter.updatedFrom !== undefined) {
        conditions.push(gte(documents.updatedAt, toTimestampStart(filter.updatedFrom)));
      }
      if (filter.updatedTo !== undefined) {
        conditions.push(lte(documents.updatedAt, toTimestampEnd(filter.updatedTo)));
      }

      const combinedTagIds = new Set<string>();
      if (filter.tagId !== undefined) {
        combinedTagIds.add(filter.tagId);
      }
      if (filter.tagIds !== undefined) {
        for (const tagId of filter.tagIds) {
          combinedTagIds.add(tagId);
        }
      }
      if (combinedTagIds.size > 0) {
        const taggedDocIds = db
          .select({ documentId: documentTags.documentId })
          .from(documentTags)
          .where(inArray(documentTags.tagId, Array.from(combinedTagIds)));
        conditions.push(inArray(documents.id, taggedDocIds));
      }

      if (filter.search !== undefined && filter.search.trim().length > 0) {
        const trimmedSearch = filter.search.trim();
        const pattern = `%${escapeLikePattern(trimmedSearch)}%`;
        const matchingByFileNameVersionIds = db
          .select({ versionId: documentVersions.id })
          .from(documentVersions)
          .innerJoin(fileObjects, eq(documentVersions.fileObjectId, fileObjects.id))
          .where(
            and(
              eq(fileObjects.organizationId, filter.organizationId),
              ilike(fileObjects.originalFileName, pattern),
            ),
          );

        const searchPredicates: SQL[] = [
          ilike(documents.title, pattern),
          inArray(documents.currentVersionId, matchingByFileNameVersionIds),
        ];

        if (enableExtractedTextSearch && filter.includeExtractedText !== false) {
          const matchingByExtractedTextVersionIds = db
            .select({ versionId: documentExtractedTexts.documentVersionId })
            .from(documentExtractedTexts)
            .where(
              and(
                eq(documentExtractedTexts.organizationId, filter.organizationId),
                sql`${documentExtractedTexts.searchVector} @@ websearch_to_tsquery(${ftsConfig}::regconfig, ${trimmedSearch})`,
              ),
            );
          searchPredicates.push(
            inArray(documents.currentVersionId, matchingByExtractedTextVersionIds),
          );
        }

        const searchClause = or(...searchPredicates);
        if (searchClause) {
          conditions.push(searchClause);
        }
      }

      if (filter.metadataFilters !== undefined) {
        for (const metaFilter of filter.metadataFilters) {
          const metaCondition = buildMetadataFilterCondition(db, metaFilter);
          if (metaCondition) {
            conditions.push(metaCondition);
          }
        }
      }

      // Authorization constraints applied strictly before COUNT(*) and pagination
      const scopeResult = buildAuthorizedDocumentScopeConditions(
        scope,
        expandedAllowedFolders,
        expandedDeniedFolders,
      );
      if (!scopeResult.allowed) {
        return emptyResult;
      }
      conditions.push(...scopeResult.conditions);

      const whereClause = and(...conditions);
      const sortColumn = ALLOWED_SEARCH_SORT_COLUMNS[filter.sortBy];
      const primaryOrder = filter.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
      const tiebreakerOrder =
        filter.sortDirection === "asc" ? asc(documents.id) : desc(documents.id);
      const offset = (filter.page - 1) * filter.pageSize;

      const [countRow] = await db.select({ total: count() }).from(documents).where(whereClause);
      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);

      const trimmedSearch = filter.search !== undefined ? filter.search.trim() : "";
      const includeExtractedTextSnippet =
        enableExtractedTextSearch &&
        filter.includeExtractedText !== false &&
        trimmedSearch.length > 0;

      const baseQuery = db
        .select({
          id: documents.id,
          title: documents.title,
          categoryId: documents.categoryId,
          folderId: documents.folderId,
          status: documents.status,
          currentVersionId: documents.currentVersionId,
          ownerUserId: documents.ownerUserId,
          issueDate: documents.issueDate,
          expirationDate: documents.expirationDate,
          version: documents.version,
          createdAt: documents.createdAt,
          updatedAt: documents.updatedAt,
          contentSnippet: includeExtractedTextSnippet
            ? sql<string | null>`CASE
                WHEN ${documentExtractedTexts.id} IS NOT NULL THEN
                  ts_headline(
                    ${ftsConfig}::regconfig,
                    ${documentExtractedTexts.extractedText},
                    websearch_to_tsquery(${ftsConfig}::regconfig, ${trimmedSearch}),
                    'MaxWords=24, MinWords=8, ShortWord=3, HighlightAll=false, StartSel=[[HL]], StopSel=[[/HL]]'
                  )
                ELSE NULL
              END`
            : sql<string | null>`NULL`,
        })
        .from(documents);

      const rows = await (includeExtractedTextSnippet
        ? baseQuery.leftJoin(
            documentExtractedTexts,
            and(
              eq(documentExtractedTexts.documentVersionId, documents.currentVersionId),
              eq(documentExtractedTexts.organizationId, filter.organizationId),
              sql`${documentExtractedTexts.searchVector} @@ websearch_to_tsquery(${ftsConfig}::regconfig, ${trimmedSearch})`,
            ),
          )
        : baseQuery
      )
        .where(whereClause)
        .orderBy(primaryOrder, tiebreakerOrder)
        .limit(filter.pageSize)
        .offset(offset);

      return {
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          categoryId: row.categoryId,
          folderId: row.folderId,
          status: row.status,
          currentVersionId: row.currentVersionId,
          ownerUserId: row.ownerUserId,
          issueDate: row.issueDate,
          expirationDate: row.expirationDate,
          version: row.version,
          ...(row.contentSnippet ? { contentSnippet: row.contentSnippet } : {}),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages,
      };
    },
  };
}
