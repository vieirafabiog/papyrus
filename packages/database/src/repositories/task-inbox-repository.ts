import type {
  DocumentStatus,
  PaginatedResult,
  WorkflowAssigneeTarget,
  WorkflowStepCommentRules,
  WorkflowStepDefinition,
  WorkflowTaskStatus,
} from "@docuflow/domain";
import { type SQL, and, asc, count, desc, eq, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documentVersions, documents } from "../schema/documents.js";
import {
  type WorkflowStepSnapshot,
  workflowDefinitionVersions,
  workflowDefinitions,
  workflowInstances,
  workflowTasks,
} from "../schema/workflows.js";
import type { AuthorizedDocumentQueryScope } from "./authorization-repository.js";
import {
  buildAuthorizedDocumentScopeConditions,
  expandFolderSubtreeIds,
} from "./authorized-scope-sql.js";

export type TaskInboxSortField = "dueAt" | "createdAt" | "status" | "stepOrder" | "id";

export interface TaskInboxFilter {
  readonly organizationId: string;
  readonly userId: string;
  readonly groupIds: readonly string[];
  readonly roleIds: readonly string[];
  readonly status?: WorkflowTaskStatus | undefined;
  readonly documentId?: string | undefined;
  readonly assigneeType?: "USER" | "GROUP" | "ROLE" | undefined;
  readonly overdueOnly?: boolean | undefined;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: TaskInboxSortField;
  readonly sortDirection: "asc" | "desc";
  readonly referenceDate?: Date | undefined;
}

export interface TaskInboxRecord {
  readonly id: string;
  readonly workflowInstanceId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly stepOrder: number;
  readonly stepName: string;
  readonly status: WorkflowTaskStatus;
  readonly assignee: WorkflowAssigneeTarget;
  readonly dueAt: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly documentTitle: string;
  readonly documentStatus: DocumentStatus;
  readonly documentVersionNumber: number;
  readonly workflowDefinitionName: string;
  readonly isOverdue: boolean;
  readonly commentRules: WorkflowStepCommentRules;
}

export type TaskDetailLookupOutcome =
  | { readonly status: "FOUND"; readonly task: TaskInboxRecord }
  | { readonly status: "FORBIDDEN" }
  | { readonly status: "NOT_FOUND" };

export interface TaskInboxRepository {
  listAuthorizedTasks(
    filter: TaskInboxFilter,
    documentScope: AuthorizedDocumentQueryScope,
  ): Promise<PaginatedResult<TaskInboxRecord>>;
  findAuthorizedTaskById(
    input: {
      readonly organizationId: string;
      readonly userId: string;
      readonly groupIds: readonly string[];
      readonly roleIds: readonly string[];
      readonly taskId: string;
      readonly referenceDate?: Date | undefined;
    },
    documentScope: AuthorizedDocumentQueryScope,
  ): Promise<TaskDetailLookupOutcome>;
}

const ALLOWED_TASK_SORT_COLUMNS: Readonly<
  Record<
    TaskInboxSortField,
    | typeof workflowTasks.dueAt
    | typeof workflowTasks.createdAt
    | typeof workflowTasks.status
    | typeof workflowTasks.stepOrder
    | typeof workflowTasks.id
  >
> = {
  dueAt: workflowTasks.dueAt,
  createdAt: workflowTasks.createdAt,
  status: workflowTasks.status,
  stepOrder: workflowTasks.stepOrder,
  id: workflowTasks.id,
};

type StoredStepSnapshot = WorkflowStepSnapshot & {
  readonly commentRules?: WorkflowStepDefinition["commentRules"];
};

function resolveStepMetadata(
  steps: readonly WorkflowStepSnapshot[],
  stepOrder: number,
): { readonly stepName: string; readonly commentRules: WorkflowStepCommentRules } {
  const step = steps.find((item) => item.stepOrder === stepOrder) as StoredStepSnapshot | undefined;
  return {
    stepName: step?.name ?? `Etapa ${stepOrder}`,
    commentRules: {
      requireOnApprove: step?.commentRules?.requireOnApprove ?? false,
      requireOnReject: true,
      requireOnRequestChanges: true,
    },
  };
}

function toTaskAssignee(
  assigneeType: "USER" | "GROUP" | "ROLE",
  targetId: string,
): WorkflowAssigneeTarget {
  switch (assigneeType) {
    case "USER":
      return { type: "USER", userId: targetId };
    case "GROUP":
      return { type: "GROUP", groupId: targetId };
    case "ROLE":
      return { type: "ROLE", roleId: targetId };
  }
}

function buildAssigneePredicate(input: {
  readonly userId: string;
  readonly groupIds: readonly string[];
  readonly roleIds: readonly string[];
  readonly assigneeTypeFilter?: "USER" | "GROUP" | "ROLE" | undefined;
}): SQL | null {
  const clauses: SQL[] = [];

  if (!input.assigneeTypeFilter || input.assigneeTypeFilter === "USER") {
    const userClause = and(
      eq(workflowTasks.assigneeType, "USER"),
      eq(workflowTasks.assigneeTargetId, input.userId),
    );
    if (userClause) {
      clauses.push(userClause);
    }
  }

  if (
    (!input.assigneeTypeFilter || input.assigneeTypeFilter === "GROUP") &&
    input.groupIds.length > 0
  ) {
    const groupClause = and(
      eq(workflowTasks.assigneeType, "GROUP"),
      inArray(workflowTasks.assigneeTargetId, [...input.groupIds]),
    );
    if (groupClause) {
      clauses.push(groupClause);
    }
  }

  if (
    (!input.assigneeTypeFilter || input.assigneeTypeFilter === "ROLE") &&
    input.roleIds.length > 0
  ) {
    const roleClause = and(
      eq(workflowTasks.assigneeType, "ROLE"),
      inArray(workflowTasks.assigneeTargetId, [...input.roleIds]),
    );
    if (roleClause) {
      clauses.push(roleClause);
    }
  }

  if (clauses.length === 0) {
    return null;
  }

  return or(...clauses) ?? null;
}

/**
 * Builds the PostgreSQL task inbox repository filtering strictly by assignee
 * (user/groups/roles) and authorized document scope before counting and paginating.
 */
export function createTaskInboxRepository(db: NodePgDatabase): TaskInboxRepository {
  return {
    async listAuthorizedTasks(
      filter: TaskInboxFilter,
      documentScope: AuthorizedDocumentQueryScope,
    ): Promise<PaginatedResult<TaskInboxRecord>> {
      const emptyResult: PaginatedResult<TaskInboxRecord> = {
        items: [],
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems: 0,
        totalPages: 0,
      };

      const referenceNow = filter.referenceDate ?? new Date();
      const assigneePredicate = buildAssigneePredicate({
        userId: filter.userId,
        groupIds: filter.groupIds,
        roleIds: filter.roleIds,
        assigneeTypeFilter: filter.assigneeType,
      });
      if (!assigneePredicate) {
        return emptyResult;
      }

      const [expandedAllowedFolders, expandedDeniedFolders] = await Promise.all([
        expandFolderSubtreeIds(db, filter.organizationId, documentScope.allowedFolderIds),
        expandFolderSubtreeIds(db, filter.organizationId, documentScope.deniedFolderIds),
      ]);

      const scopeResult = buildAuthorizedDocumentScopeConditions(
        documentScope,
        expandedAllowedFolders,
        expandedDeniedFolders,
      );
      if (!scopeResult.allowed) {
        return emptyResult;
      }

      const conditions: SQL[] = [
        eq(workflowTasks.organizationId, filter.organizationId),
        eq(documents.organizationId, filter.organizationId),
        ne(documents.status, "DELETED"),
        assigneePredicate,
        ...scopeResult.conditions,
      ];

      if (filter.status !== undefined) {
        conditions.push(eq(workflowTasks.status, filter.status));
      }
      if (filter.documentId !== undefined) {
        conditions.push(eq(workflowTasks.documentId, filter.documentId));
      }
      if (filter.overdueOnly) {
        conditions.push(eq(workflowTasks.status, "PENDING"));
        conditions.push(isNotNull(workflowTasks.dueAt));
        conditions.push(lt(workflowTasks.dueAt, referenceNow));
      }

      const whereClause = and(...conditions);

      const [countRow] = await db
        .select({ total: count() })
        .from(workflowTasks)
        .innerJoin(documents, eq(workflowTasks.documentId, documents.id))
        .where(whereClause);

      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);
      if (totalItems === 0) {
        return emptyResult;
      }

      const sortColumn = ALLOWED_TASK_SORT_COLUMNS[filter.sortBy];
      const primaryOrder = filter.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
      const tiebreakerOrder =
        filter.sortDirection === "asc" ? asc(workflowTasks.id) : desc(workflowTasks.id);
      const offset = (filter.page - 1) * filter.pageSize;

      const rows = await db
        .select({
          task: workflowTasks,
          documentTitle: documents.title,
          documentStatus: documents.status,
          documentVersionNumber: documentVersions.versionNumber,
          workflowDefinitionName: workflowDefinitions.name,
          steps: workflowDefinitionVersions.steps,
        })
        .from(workflowTasks)
        .innerJoin(documents, eq(workflowTasks.documentId, documents.id))
        .innerJoin(documentVersions, eq(workflowTasks.documentVersionId, documentVersions.id))
        .innerJoin(workflowInstances, eq(workflowTasks.workflowInstanceId, workflowInstances.id))
        .innerJoin(
          workflowDefinitionVersions,
          eq(workflowInstances.workflowDefinitionVersionId, workflowDefinitionVersions.id),
        )
        .innerJoin(
          workflowDefinitions,
          eq(workflowDefinitionVersions.workflowDefinitionId, workflowDefinitions.id),
        )
        .where(whereClause)
        .orderBy(primaryOrder, tiebreakerOrder)
        .limit(filter.pageSize)
        .offset(offset);

      return {
        items: rows.map((row) => {
          const stepMeta = resolveStepMetadata(row.steps, row.task.stepOrder);
          const isOverdue =
            row.task.status === "PENDING" &&
            row.task.dueAt !== null &&
            row.task.dueAt.getTime() < referenceNow.getTime();

          return {
            id: row.task.id,
            workflowInstanceId: row.task.workflowInstanceId,
            documentId: row.task.documentId,
            documentVersionId: row.task.documentVersionId,
            stepOrder: row.task.stepOrder,
            stepName: stepMeta.stepName,
            status: row.task.status,
            assignee: toTaskAssignee(row.task.assigneeType, row.task.assigneeTargetId),
            dueAt: row.task.dueAt ? row.task.dueAt.toISOString() : null,
            createdAt: row.task.createdAt.toISOString(),
            decidedAt: row.task.decidedAt ? row.task.decidedAt.toISOString() : null,
            documentTitle: row.documentTitle,
            documentStatus: row.documentStatus,
            documentVersionNumber: row.documentVersionNumber,
            workflowDefinitionName: row.workflowDefinitionName,
            isOverdue,
            commentRules: stepMeta.commentRules,
          };
        }),
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages,
      };
    },

    async findAuthorizedTaskById(
      input: {
        readonly organizationId: string;
        readonly userId: string;
        readonly groupIds: readonly string[];
        readonly roleIds: readonly string[];
        readonly taskId: string;
        readonly referenceDate?: Date | undefined;
      },
      documentScope: AuthorizedDocumentQueryScope,
    ): Promise<TaskDetailLookupOutcome> {
      const referenceNow = input.referenceDate ?? new Date();

      const [existingRow] = await db
        .select({ id: workflowTasks.id, organizationId: workflowTasks.organizationId })
        .from(workflowTasks)
        .where(eq(workflowTasks.id, input.taskId))
        .limit(1);

      if (!existingRow || existingRow.organizationId !== input.organizationId) {
        return { status: "NOT_FOUND" };
      }

      const assigneePredicate = buildAssigneePredicate({
        userId: input.userId,
        groupIds: input.groupIds,
        roleIds: input.roleIds,
      });
      if (!assigneePredicate) {
        return { status: "FORBIDDEN" };
      }

      const [expandedAllowedFolders, expandedDeniedFolders] = await Promise.all([
        expandFolderSubtreeIds(db, input.organizationId, documentScope.allowedFolderIds),
        expandFolderSubtreeIds(db, input.organizationId, documentScope.deniedFolderIds),
      ]);

      const scopeResult = buildAuthorizedDocumentScopeConditions(
        documentScope,
        expandedAllowedFolders,
        expandedDeniedFolders,
      );
      if (!scopeResult.allowed) {
        return { status: "FORBIDDEN" };
      }

      const [row] = await db
        .select({
          task: workflowTasks,
          documentTitle: documents.title,
          documentStatus: documents.status,
          documentVersionNumber: documentVersions.versionNumber,
          workflowDefinitionName: workflowDefinitions.name,
          steps: workflowDefinitionVersions.steps,
        })
        .from(workflowTasks)
        .innerJoin(documents, eq(workflowTasks.documentId, documents.id))
        .innerJoin(documentVersions, eq(workflowTasks.documentVersionId, documentVersions.id))
        .innerJoin(workflowInstances, eq(workflowTasks.workflowInstanceId, workflowInstances.id))
        .innerJoin(
          workflowDefinitionVersions,
          eq(workflowInstances.workflowDefinitionVersionId, workflowDefinitionVersions.id),
        )
        .innerJoin(
          workflowDefinitions,
          eq(workflowDefinitionVersions.workflowDefinitionId, workflowDefinitions.id),
        )
        .where(
          and(
            eq(workflowTasks.id, input.taskId),
            eq(workflowTasks.organizationId, input.organizationId),
            eq(documents.organizationId, input.organizationId),
            ne(documents.status, "DELETED"),
            assigneePredicate,
            ...scopeResult.conditions,
          ),
        )
        .limit(1);

      if (!row) {
        return { status: "FORBIDDEN" };
      }

      const stepMeta = resolveStepMetadata(row.steps, row.task.stepOrder);
      const isOverdue =
        row.task.status === "PENDING" &&
        row.task.dueAt !== null &&
        row.task.dueAt.getTime() < referenceNow.getTime();

      return {
        status: "FOUND",
        task: {
          id: row.task.id,
          workflowInstanceId: row.task.workflowInstanceId,
          documentId: row.task.documentId,
          documentVersionId: row.task.documentVersionId,
          stepOrder: row.task.stepOrder,
          stepName: stepMeta.stepName,
          status: row.task.status,
          assignee: toTaskAssignee(row.task.assigneeType, row.task.assigneeTargetId),
          dueAt: row.task.dueAt ? row.task.dueAt.toISOString() : null,
          createdAt: row.task.createdAt.toISOString(),
          decidedAt: row.task.decidedAt ? row.task.decidedAt.toISOString() : null,
          documentTitle: row.documentTitle,
          documentStatus: row.documentStatus,
          documentVersionNumber: row.documentVersionNumber,
          workflowDefinitionName: row.workflowDefinitionName,
          isOverdue,
          commentRules: stepMeta.commentRules,
        },
      };
    },
  };
}
