import {
  DEFAULT_EXPIRATION_TIMEZONE,
  type DocumentStatus,
  addCalendarDays,
  isValidIanaTimeZone,
  resolveLocalCalendarDate,
} from "@docuflow/domain";
import { type SQL, and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documentVersions, documents } from "../schema/documents.js";
import { organizations } from "../schema/identity.js";
import { fileObjects, storageConnections, uploadSessions } from "../schema/storage.js";
import { categories } from "../schema/taxonomy.js";
import { workflowTasks } from "../schema/workflows.js";
import type { AuthorizedDocumentQueryScope } from "./authorization-repository.js";
import {
  buildAuthorizedDocumentScopeConditions,
  expandFolderSubtreeIds,
} from "./authorized-scope-sql.js";

const DEFAULT_EXPIRATION_WINDOW_DAYS = 30;
const ACTIVE_FILE_STATUSES = ["UPLOADING", "QUARANTINED", "AVAILABLE"] as const;

export interface RepositoryReportQueryInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly groupIds: readonly string[];
  readonly roleIds: readonly string[];
  readonly scope: AuthorizedDocumentQueryScope;
  readonly expirationWindowDays?: number | undefined;
  readonly categoryId?: string | undefined;
  readonly status?: DocumentStatus | undefined;
  readonly referenceDate?: Date | undefined;
}

export interface RepositoryReportStatusItem {
  readonly status: DocumentStatus;
  readonly documentCount: number;
  readonly storageBytes: number;
}

export interface RepositoryReportCategoryItem {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly documentCount: number;
  readonly versionCount: number;
  readonly storageBytes: number;
  readonly expiredCount: number;
  readonly expiringSoonCount: number;
}

export interface RepositoryReportStorageConnectionItem {
  readonly storageConnectionId: string;
  readonly storageConnectionName: string;
  readonly kind: string;
  readonly fileCount: number;
  readonly storageBytes: number;
}

export interface RepositoryReportRecord {
  readonly generatedAt: string;
  readonly timezone: string;
  readonly totals: {
    readonly totalDocuments: number;
    readonly totalVersions: number;
    readonly totalActiveFiles: number;
    readonly storageUsedBytes: number;
    readonly quarantinedFiles: number;
    readonly pendingTasks: number;
  };
  readonly expirations: {
    readonly expired: number;
    readonly expiringSoon: number;
    readonly onTrack: number;
    readonly withoutDate: number;
    readonly windowDays: number;
  };
  readonly byStatus: readonly RepositoryReportStatusItem[];
  readonly byCategory: readonly RepositoryReportCategoryItem[];
  readonly byStorageConnection: readonly RepositoryReportStorageConnectionItem[];
}

export interface ReportRepository {
  getAuthorizedRepositoryReport(input: RepositoryReportQueryInput): Promise<RepositoryReportRecord>;
}

/**
 * Executes consolidated repository reports strictly in PostgreSQL within the caller's
 * authorized scope so unauthorized documents, categories, or file sizes never leak by count.
 */
export function createReportRepository(db: NodePgDatabase): ReportRepository {
  return {
    async getAuthorizedRepositoryReport(
      input: RepositoryReportQueryInput,
    ): Promise<RepositoryReportRecord> {
      const referenceDate = input.referenceDate ?? new Date();
      const windowDays = Math.min(
        365,
        Math.max(1, input.expirationWindowDays ?? DEFAULT_EXPIRATION_WINDOW_DAYS),
      );

      const [orgRow] = await db
        .select({ timezone: organizations.timezone })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1);

      const timezone =
        orgRow?.timezone && isValidIanaTimeZone(orgRow.timezone)
          ? orgRow.timezone
          : DEFAULT_EXPIRATION_TIMEZONE;

      const todayLocal = resolveLocalCalendarDate(referenceDate, timezone);
      const soonEndLocal = addCalendarDays(todayLocal, windowDays);

      const [expandedAllowedFolders, expandedDeniedFolders] = await Promise.all([
        expandFolderSubtreeIds(db, input.organizationId, input.scope.allowedFolderIds),
        expandFolderSubtreeIds(db, input.organizationId, input.scope.deniedFolderIds),
      ]);

      const scopeResult = buildAuthorizedDocumentScopeConditions(
        input.scope,
        expandedAllowedFolders,
        expandedDeniedFolders,
      );

      const userUploadedFileIds = db
        .select({ fileObjectId: uploadSessions.fileObjectId })
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.organizationId, input.organizationId),
            eq(uploadSessions.userId, input.userId),
          ),
        );

      if (!scopeResult.allowed) {
        const [quarantineAgg] = await db
          .select({ quarantinedFiles: sql<number>`count(*)::int` })
          .from(fileObjects)
          .where(
            and(
              eq(fileObjects.organizationId, input.organizationId),
              eq(fileObjects.status, "QUARANTINED"),
              inArray(fileObjects.id, userUploadedFileIds),
            ),
          );

        return {
          generatedAt: referenceDate.toISOString(),
          timezone,
          totals: {
            totalDocuments: 0,
            totalVersions: 0,
            totalActiveFiles: 0,
            storageUsedBytes: 0,
            quarantinedFiles: Number(quarantineAgg?.quarantinedFiles ?? 0),
            pendingTasks: 0,
          },
          expirations: {
            expired: 0,
            expiringSoon: 0,
            onTrack: 0,
            withoutDate: 0,
            windowDays,
          },
          byStatus: [],
          byCategory: [],
          byStorageConnection: [],
        };
      }

      const docConditions: SQL[] = [
        eq(documents.organizationId, input.organizationId),
        ...scopeResult.conditions,
      ];
      if (input.status !== undefined) {
        docConditions.push(eq(documents.status, input.status));
      } else {
        docConditions.push(ne(documents.status, "DELETED"));
      }
      if (input.categoryId !== undefined) {
        docConditions.push(eq(documents.categoryId, input.categoryId));
      }

      const docWhere = and(...docConditions);
      const authorizedDocIds = db.select({ id: documents.id }).from(documents).where(docWhere);
      const linkedAuthorizedFileIds = db
        .select({ fileObjectId: documentVersions.fileObjectId })
        .from(documentVersions)
        .innerJoin(documents, eq(documentVersions.documentId, documents.id))
        .where(docWhere);

      const assigneePredicates: SQL[] = [];
      const userAssignee = and(
        eq(workflowTasks.assigneeType, "USER"),
        eq(workflowTasks.assigneeTargetId, input.userId),
      );
      if (userAssignee) {
        assigneePredicates.push(userAssignee);
      }
      if (input.groupIds.length > 0) {
        const groupAssignee = and(
          eq(workflowTasks.assigneeType, "GROUP"),
          inArray(workflowTasks.assigneeTargetId, [...input.groupIds]),
        );
        if (groupAssignee) {
          assigneePredicates.push(groupAssignee);
        }
      }
      if (input.roleIds.length > 0) {
        const roleAssignee = and(
          eq(workflowTasks.assigneeType, "ROLE"),
          inArray(workflowTasks.assigneeTargetId, [...input.roleIds]),
        );
        if (roleAssignee) {
          assigneePredicates.push(roleAssignee);
        }
      }
      const combinedAssignee =
        assigneePredicates.length > 0 ? or(...assigneePredicates) : undefined;

      const quarantineScopePredicate = or(
        inArray(fileObjects.id, linkedAuthorizedFileIds),
        inArray(fileObjects.id, userUploadedFileIds),
      );

      const statusDistinctFiles = db
        .selectDistinct({
          status: documents.status,
          fileObjectId: fileObjects.id,
          sizeBytes: fileObjects.sizeBytes,
        })
        .from(documentVersions)
        .innerJoin(documents, eq(documentVersions.documentId, documents.id))
        .innerJoin(fileObjects, eq(documentVersions.fileObjectId, fileObjects.id))
        .where(and(docWhere, inArray(fileObjects.status, [...ACTIVE_FILE_STATUSES])))
        .as("status_distinct_files");

      const categoryDistinctFiles = db
        .selectDistinct({
          categoryId: documents.categoryId,
          fileObjectId: fileObjects.id,
          sizeBytes: fileObjects.sizeBytes,
        })
        .from(documentVersions)
        .innerJoin(documents, eq(documentVersions.documentId, documents.id))
        .innerJoin(fileObjects, eq(documentVersions.fileObjectId, fileObjects.id))
        .where(and(docWhere, inArray(fileObjects.status, [...ACTIVE_FILE_STATUSES])))
        .as("category_distinct_files");

      const [
        [docTotalsRow],
        [versionsCountRow],
        [storageTotalsRow],
        [quarantineAgg],
        [taskAgg],
        statusDocRows,
        statusStorageRows,
        categoryDocRows,
        categoryVersionRows,
        categoryStorageRows,
        storageByConnRows,
      ] = await Promise.all([
        db
          .select({
            totalDocuments: sql<number>`count(*)::int`,
            expired: sql<number>`count(*) filter (where ${documents.expirationDate} is not null and ${documents.expirationDate} < ${todayLocal} and ${documents.status} not in ('ARCHIVED', 'DELETED'))::int`,
            expiringSoon: sql<number>`count(*) filter (where ${documents.expirationDate} is not null and ${documents.expirationDate} >= ${todayLocal} and ${documents.expirationDate} <= ${soonEndLocal} and ${documents.status} not in ('ARCHIVED', 'DELETED'))::int`,
            onTrack: sql<number>`count(*) filter (where ${documents.expirationDate} is not null and ${documents.expirationDate} > ${soonEndLocal} and ${documents.status} not in ('ARCHIVED', 'DELETED'))::int`,
            withoutDate: sql<number>`count(*) filter (where ${documents.expirationDate} is null and ${documents.status} not in ('ARCHIVED', 'DELETED'))::int`,
          })
          .from(documents)
          .where(docWhere),

        db
          .select({
            totalVersions: sql<number>`count(*)::int`,
          })
          .from(documentVersions)
          .innerJoin(documents, eq(documentVersions.documentId, documents.id))
          .where(docWhere),

        db
          .select({
            storageUsedBytes: sql<string>`coalesce(sum(${fileObjects.sizeBytes}), 0)::bigint`,
            totalActiveFiles: sql<number>`count(*)::int`,
          })
          .from(fileObjects)
          .where(
            and(
              eq(fileObjects.organizationId, input.organizationId),
              inArray(fileObjects.status, [...ACTIVE_FILE_STATUSES]),
              inArray(fileObjects.id, linkedAuthorizedFileIds),
            ),
          ),

        db
          .select({ quarantinedFiles: sql<number>`count(*)::int` })
          .from(fileObjects)
          .where(
            and(
              eq(fileObjects.organizationId, input.organizationId),
              eq(fileObjects.status, "QUARANTINED"),
              quarantineScopePredicate,
            ),
          ),

        combinedAssignee
          ? db
              .select({ pendingTasks: sql<number>`count(*)::int` })
              .from(workflowTasks)
              .where(
                and(
                  eq(workflowTasks.organizationId, input.organizationId),
                  eq(workflowTasks.status, "PENDING"),
                  inArray(workflowTasks.documentId, authorizedDocIds),
                  combinedAssignee,
                ),
              )
          : Promise.resolve([{ pendingTasks: 0 }]),

        db
          .select({
            status: documents.status,
            documentCount: sql<number>`count(*)::int`,
          })
          .from(documents)
          .where(docWhere)
          .groupBy(documents.status)
          .orderBy(desc(sql`count(*)`), documents.status),

        db
          .select({
            status: statusDistinctFiles.status,
            storageBytes: sql<string>`coalesce(sum(${statusDistinctFiles.sizeBytes}), 0)::bigint`,
          })
          .from(statusDistinctFiles)
          .groupBy(statusDistinctFiles.status),

        db
          .select({
            categoryId: categories.id,
            categoryName: categories.name,
            documentCount: sql<number>`count(${documents.id})::int`,
            expiredCount: sql<number>`count(*) filter (where ${documents.expirationDate} is not null and ${documents.expirationDate} < ${todayLocal} and ${documents.status} not in ('ARCHIVED', 'DELETED'))::int`,
            expiringSoonCount: sql<number>`count(*) filter (where ${documents.expirationDate} is not null and ${documents.expirationDate} >= ${todayLocal} and ${documents.expirationDate} <= ${soonEndLocal} and ${documents.status} not in ('ARCHIVED', 'DELETED'))::int`,
          })
          .from(documents)
          .innerJoin(categories, eq(documents.categoryId, categories.id))
          .where(docWhere)
          .groupBy(categories.id, categories.name)
          .orderBy(desc(sql`count(${documents.id})`), categories.name),

        db
          .select({
            categoryId: documents.categoryId,
            versionCount: sql<number>`count(${documentVersions.id})::int`,
          })
          .from(documentVersions)
          .innerJoin(documents, eq(documentVersions.documentId, documents.id))
          .where(docWhere)
          .groupBy(documents.categoryId),

        db
          .select({
            categoryId: categoryDistinctFiles.categoryId,
            storageBytes: sql<string>`coalesce(sum(${categoryDistinctFiles.sizeBytes}), 0)::bigint`,
          })
          .from(categoryDistinctFiles)
          .groupBy(categoryDistinctFiles.categoryId),

        db
          .select({
            storageConnectionId: storageConnections.id,
            storageConnectionName: storageConnections.name,
            kind: storageConnections.kind,
            fileCount: sql<number>`count(${fileObjects.id})::int`,
            storageBytes: sql<string>`coalesce(sum(${fileObjects.sizeBytes}), 0)::bigint`,
          })
          .from(fileObjects)
          .innerJoin(storageConnections, eq(fileObjects.storageConnectionId, storageConnections.id))
          .where(
            and(
              eq(fileObjects.organizationId, input.organizationId),
              inArray(fileObjects.status, [...ACTIVE_FILE_STATUSES]),
              inArray(fileObjects.id, linkedAuthorizedFileIds),
            ),
          )
          .groupBy(storageConnections.id, storageConnections.name, storageConnections.kind)
          .orderBy(desc(sql`coalesce(sum(${fileObjects.sizeBytes}), 0)`), storageConnections.name),
      ]);

      const statusStorageByStatus = new Map<string, number>(
        statusStorageRows.map((row) => [row.status, Number(row.storageBytes ?? 0)]),
      );
      const versionCountByCategory = new Map<string, number>(
        categoryVersionRows.map((row) => [row.categoryId, Number(row.versionCount ?? 0)]),
      );
      const storageByCategory = new Map<string, number>(
        categoryStorageRows.map((row) => [row.categoryId, Number(row.storageBytes ?? 0)]),
      );

      return {
        generatedAt: referenceDate.toISOString(),
        timezone,
        totals: {
          totalDocuments: Number(docTotalsRow?.totalDocuments ?? 0),
          totalVersions: Number(versionsCountRow?.totalVersions ?? 0),
          totalActiveFiles: Number(storageTotalsRow?.totalActiveFiles ?? 0),
          storageUsedBytes: Number(storageTotalsRow?.storageUsedBytes ?? 0),
          quarantinedFiles: Number(quarantineAgg?.quarantinedFiles ?? 0),
          pendingTasks: Number(taskAgg?.pendingTasks ?? 0),
        },
        expirations: {
          expired: Number(docTotalsRow?.expired ?? 0),
          expiringSoon: Number(docTotalsRow?.expiringSoon ?? 0),
          onTrack: Number(docTotalsRow?.onTrack ?? 0),
          withoutDate: Number(docTotalsRow?.withoutDate ?? 0),
          windowDays,
        },
        byStatus: statusDocRows.map((row) => ({
          status: row.status,
          documentCount: Number(row.documentCount ?? 0),
          storageBytes: statusStorageByStatus.get(row.status) ?? 0,
        })),
        byCategory: categoryDocRows.map((row) => ({
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          documentCount: Number(row.documentCount ?? 0),
          versionCount: versionCountByCategory.get(row.categoryId) ?? 0,
          storageBytes: storageByCategory.get(row.categoryId) ?? 0,
          expiredCount: Number(row.expiredCount ?? 0),
          expiringSoonCount: Number(row.expiringSoonCount ?? 0),
        })),
        byStorageConnection: storageByConnRows.map((row) => ({
          storageConnectionId: row.storageConnectionId,
          storageConnectionName: row.storageConnectionName,
          kind: row.kind,
          fileCount: Number(row.fileCount ?? 0),
          storageBytes: Number(row.storageBytes ?? 0),
        })),
      };
    },
  };
}
