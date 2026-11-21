import { type SQL, and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documentVersions, documents } from "../schema/documents.js";
import { auditEvents } from "../schema/governance.js";
import { fileObjects, uploadSessions } from "../schema/storage.js";
import { workflowTasks } from "../schema/workflows.js";
import type { AuthorizedDocumentQueryScope } from "./authorization-repository.js";
import {
  buildAuthorizedDocumentScopeConditions,
  expandFolderSubtreeIds,
} from "./authorized-scope-sql.js";

const DEFAULT_EXPIRING_WINDOW_DAYS = 30;
const DEFAULT_RECENT_ACTIVITY_LIMIT = 10;

export interface DashboardSummaryQueryInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly groupIds: readonly string[];
  readonly roleIds: readonly string[];
  readonly scope: AuthorizedDocumentQueryScope;
  readonly canViewGlobalAudit: boolean;
  readonly referenceDate?: Date | undefined;
  readonly expiringWindowDays?: number | undefined;
  readonly recentActivityLimit?: number | undefined;
}

export interface DashboardRecentActivityRecord {
  readonly id: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly occurredAt: string;
}

export interface DashboardSummaryRecord {
  readonly totalDocuments: number;
  readonly pendingTasks: number;
  readonly expiringSoonDocuments: number;
  readonly quarantinedFiles: number;
  readonly storageUsedBytes: number;
  readonly storageFileCount: number;
  readonly recentActivity: readonly DashboardRecentActivityRecord[];
}

export interface DashboardRepository {
  getAuthorizedSummary(input: DashboardSummaryQueryInput): Promise<DashboardSummaryRecord>;
}

function formatUtcIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Creates the PostgreSQL dashboard repository that executes all indicator counts,
 * storage totals, pending task counts, and recent audit activity strictly in SQL
 * within the caller's authorized document and audit scope.
 */
export function createDashboardRepository(db: NodePgDatabase): DashboardRepository {
  return {
    async getAuthorizedSummary(input: DashboardSummaryQueryInput): Promise<DashboardSummaryRecord> {
      const referenceDate = input.referenceDate ?? new Date();
      const windowDays = input.expiringWindowDays ?? DEFAULT_EXPIRING_WINDOW_DAYS;
      const activityLimit = input.recentActivityLimit ?? DEFAULT_RECENT_ACTIVITY_LIMIT;

      const todayIsoDate = formatUtcIsoDate(referenceDate);
      const soonDate = new Date(referenceDate.getTime() + windowDays * 24 * 60 * 60 * 1000);
      const soonIsoDate = formatUtcIsoDate(soonDate);

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
          .select({
            quarantinedFiles: sql<number>`count(*)::int`,
          })
          .from(fileObjects)
          .where(
            and(
              eq(fileObjects.organizationId, input.organizationId),
              eq(fileObjects.status, "QUARANTINED"),
              inArray(fileObjects.id, userUploadedFileIds),
            ),
          );

        const auditRows = input.canViewGlobalAudit
          ? await db
              .select({
                id: auditEvents.id,
                action: auditEvents.action,
                resourceType: auditEvents.resourceType,
                resourceId: auditEvents.resourceId,
                occurredAt: auditEvents.occurredAt,
              })
              .from(auditEvents)
              .where(eq(auditEvents.organizationId, input.organizationId))
              .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
              .limit(activityLimit)
          : [];

        return {
          totalDocuments: 0,
          pendingTasks: 0,
          expiringSoonDocuments: 0,
          quarantinedFiles: Number(quarantineAgg?.quarantinedFiles ?? 0),
          storageUsedBytes: 0,
          storageFileCount: 0,
          recentActivity: auditRows.map((row) => ({
            id: row.id,
            action: row.action,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            occurredAt: row.occurredAt.toISOString(),
          })),
        };
      }

      const docWhere = and(
        eq(documents.organizationId, input.organizationId),
        ne(documents.status, "DELETED"),
        ...scopeResult.conditions,
      );

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

      const recentActivityWhere = input.canViewGlobalAudit
        ? eq(auditEvents.organizationId, input.organizationId)
        : and(
            eq(auditEvents.organizationId, input.organizationId),
            eq(auditEvents.resourceType, "DOCUMENT"),
            inArray(auditEvents.resourceId, authorizedDocIds),
          );

      const [[docAgg], [storageAgg], [quarantineAgg], [taskAgg], auditRows] = await Promise.all([
        db
          .select({
            totalDocuments: sql<number>`count(*)::int`,
            expiringSoonDocuments: sql<number>`count(*) filter (where ${documents.expirationDate} is not null and ${documents.expirationDate} >= ${todayIsoDate} and ${documents.expirationDate} <= ${soonIsoDate} and ${documents.status} not in ('ARCHIVED', 'DELETED'))::int`,
          })
          .from(documents)
          .where(docWhere),
        db
          .select({
            storageUsedBytes: sql<string>`coalesce(sum(${fileObjects.sizeBytes}), 0)::bigint`,
            storageFileCount: sql<number>`count(*)::int`,
          })
          .from(fileObjects)
          .where(
            and(
              eq(fileObjects.organizationId, input.organizationId),
              inArray(fileObjects.status, ["UPLOADING", "QUARANTINED", "AVAILABLE"]),
              inArray(fileObjects.id, linkedAuthorizedFileIds),
            ),
          ),
        db
          .select({
            quarantinedFiles: sql<number>`count(*)::int`,
          })
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
              .select({
                pendingTasks: sql<number>`count(*)::int`,
              })
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
            id: auditEvents.id,
            action: auditEvents.action,
            resourceType: auditEvents.resourceType,
            resourceId: auditEvents.resourceId,
            occurredAt: auditEvents.occurredAt,
          })
          .from(auditEvents)
          .where(recentActivityWhere)
          .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
          .limit(activityLimit),
      ]);

      return {
        totalDocuments: Number(docAgg?.totalDocuments ?? 0),
        pendingTasks: Number(taskAgg?.pendingTasks ?? 0),
        expiringSoonDocuments: Number(docAgg?.expiringSoonDocuments ?? 0),
        quarantinedFiles: Number(quarantineAgg?.quarantinedFiles ?? 0),
        storageUsedBytes: Number(storageAgg?.storageUsedBytes ?? 0),
        storageFileCount: Number(storageAgg?.storageFileCount ?? 0),
        recentActivity: auditRows.map((row) => ({
          id: row.id,
          action: row.action,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          occurredAt: row.occurredAt.toISOString(),
        })),
      };
    },
  };
}
