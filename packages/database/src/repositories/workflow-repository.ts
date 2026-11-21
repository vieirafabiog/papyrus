import {
  type AccessScope,
  type CreateWorkflowDecisionRecordInput,
  type CreateWorkflowDefinitionRecordInput,
  type CreateWorkflowInstanceRecordInput,
  type CreateWorkflowTaskIdempotentInput,
  type CreateWorkflowTaskRecordResult,
  type CreatedWorkflowDefinitionRecords,
  DomainError,
  type PublishWorkflowDefinitionVersionInput,
  type TransactionContext,
  type TransitionWorkflowTaskFromPendingInput,
  type UpdateWorkflowDefinitionInput,
  type UpdateWorkflowInstanceProgressInput,
  type WorkflowAssigneeAuthorizationPort,
  type WorkflowAssigneeTarget,
  type WorkflowDecisionEntity,
  type WorkflowDecisionRepositoryPort,
  type WorkflowDefinitionEntity,
  type WorkflowDefinitionRepositoryPort,
  type WorkflowDefinitionVersionEntity,
  type WorkflowInstanceEntity,
  type WorkflowInstanceRepositoryPort,
  type WorkflowStepDefinition,
  type WorkflowTaskEntity,
  type WorkflowTaskRepositoryPort,
} from "@docuflow/domain";
import { and, asc, desc, eq, ilike, inArray, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documents } from "../schema/documents.js";
import {
  groups,
  permissions,
  rolePermissions,
  roles,
  userGroups,
  userRoleScopes,
  users,
} from "../schema/identity.js";
import { folders } from "../schema/taxonomy.js";
import {
  type WorkflowStepSnapshot,
  workflowDecisions,
  workflowDefinitionVersions,
  workflowDefinitions,
  workflowInstances,
  workflowTasks,
} from "../schema/workflows.js";
import { resolveDbExecutor } from "./transaction-manager.js";

type StoredStepSnapshot = WorkflowStepSnapshot & {
  readonly commentRules?: WorkflowStepDefinition["commentRules"];
};

function toStepSnapshots(steps: readonly WorkflowStepDefinition[]): WorkflowStepSnapshot[] {
  return steps.map((step) => {
    const assigneeTargetId =
      step.assignee.type === "USER"
        ? step.assignee.userId
        : step.assignee.type === "GROUP"
          ? step.assignee.groupId
          : step.assignee.roleId;

    const snapshot: StoredStepSnapshot = {
      stepOrder: step.stepOrder,
      name: step.name,
      assigneeType: step.assignee.type,
      assigneeTargetId,
      dueDays: step.dueDays,
      ...(step.commentRules ? { commentRules: step.commentRules } : {}),
    };
    return snapshot;
  });
}

function fromStepSnapshots(snapshots: readonly WorkflowStepSnapshot[]): WorkflowStepDefinition[] {
  return snapshots.map((snapshot) => {
    const stored = snapshot as StoredStepSnapshot;
    const assignee: WorkflowAssigneeTarget =
      snapshot.assigneeType === "USER"
        ? { type: "USER", userId: snapshot.assigneeTargetId }
        : snapshot.assigneeType === "GROUP"
          ? { type: "GROUP", groupId: snapshot.assigneeTargetId }
          : { type: "ROLE", roleId: snapshot.assigneeTargetId };

    return {
      stepOrder: snapshot.stepOrder,
      name: snapshot.name,
      assignee,
      dueDays: snapshot.dueDays,
      ...(stored.commentRules ? { commentRules: stored.commentRules } : {}),
    };
  });
}

function toWorkflowDefinitionEntity(
  row: typeof workflowDefinitions.$inferSelect,
): WorkflowDefinitionEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    latestVersionNumber: row.latestVersionNumber,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWorkflowDefinitionVersionEntity(
  row: typeof workflowDefinitionVersions.$inferSelect,
): WorkflowDefinitionVersionEntity {
  return {
    id: row.id,
    workflowDefinitionId: row.workflowDefinitionId,
    versionNumber: row.versionNumber,
    steps: fromStepSnapshots(row.steps),
    createdAt: row.createdAt.toISOString(),
  };
}

function toWorkflowInstanceEntity(
  row: typeof workflowInstances.$inferSelect,
): WorkflowInstanceEntity {
  return {
    id: row.id,
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    workflowDefinitionVersionId: row.workflowDefinitionVersionId,
    status: row.status,
    currentStepOrder: row.currentStepOrder,
    startedByUserId: row.startedByUserId,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

function toWorkflowTaskEntity(row: typeof workflowTasks.$inferSelect): WorkflowTaskEntity {
  const assignee: WorkflowAssigneeTarget =
    row.assigneeType === "USER"
      ? { type: "USER", userId: row.assigneeTargetId }
      : row.assigneeType === "GROUP"
        ? { type: "GROUP", groupId: row.assigneeTargetId }
        : { type: "ROLE", roleId: row.assigneeTargetId };

  return {
    id: row.id,
    workflowInstanceId: row.workflowInstanceId,
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    stepOrder: row.stepOrder,
    status: row.status,
    assignee,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

export function createWorkflowDefinitionRepository(
  db: NodePgDatabase,
): WorkflowDefinitionRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<WorkflowDefinitionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, id))
        .limit(1);
      return row ? toWorkflowDefinitionEntity(row) : null;
    },

    async findByName(
      organizationId: string,
      name: string,
      tx?: TransactionContext,
    ): Promise<WorkflowDefinitionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(workflowDefinitions)
        .where(
          and(
            eq(workflowDefinitions.organizationId, organizationId),
            ilike(workflowDefinitions.name, name),
          ),
        )
        .limit(1);
      return row ? toWorkflowDefinitionEntity(row) : null;
    },

    async listByOrganization(
      organizationId: string,
      options?: { readonly activeOnly?: boolean | undefined },
      tx?: TransactionContext,
    ): Promise<readonly WorkflowDefinitionEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const predicate = options?.activeOnly
        ? and(
            eq(workflowDefinitions.organizationId, organizationId),
            eq(workflowDefinitions.isActive, true),
          )
        : eq(workflowDefinitions.organizationId, organizationId);

      const rows = await executor
        .select()
        .from(workflowDefinitions)
        .where(predicate)
        .orderBy(asc(workflowDefinitions.name), asc(workflowDefinitions.id));

      return rows.map(toWorkflowDefinitionEntity);
    },

    async findVersionById(
      versionId: string,
      tx?: TransactionContext,
    ): Promise<WorkflowDefinitionVersionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(workflowDefinitionVersions)
        .where(eq(workflowDefinitionVersions.id, versionId))
        .limit(1);
      return row ? toWorkflowDefinitionVersionEntity(row) : null;
    },

    async findVersionByNumber(
      workflowDefinitionId: string,
      versionNumber: number,
      tx?: TransactionContext,
    ): Promise<WorkflowDefinitionVersionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(workflowDefinitionVersions)
        .where(
          and(
            eq(workflowDefinitionVersions.workflowDefinitionId, workflowDefinitionId),
            eq(workflowDefinitionVersions.versionNumber, versionNumber),
          ),
        )
        .limit(1);
      return row ? toWorkflowDefinitionVersionEntity(row) : null;
    },

    async listVersions(
      workflowDefinitionId: string,
      tx?: TransactionContext,
    ): Promise<readonly WorkflowDefinitionVersionEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select()
        .from(workflowDefinitionVersions)
        .where(eq(workflowDefinitionVersions.workflowDefinitionId, workflowDefinitionId))
        .orderBy(asc(workflowDefinitionVersions.versionNumber));
      return rows.map(toWorkflowDefinitionVersionEntity);
    },

    async createWithInitialVersion(
      input: CreateWorkflowDefinitionRecordInput,
      tx?: TransactionContext,
    ): Promise<CreatedWorkflowDefinitionRecords> {
      const executor = resolveDbExecutor(db, tx);
      const [defRow] = await executor
        .insert(workflowDefinitions)
        .values({
          id: input.definitionId,
          organizationId: input.organizationId,
          name: input.name,
          description: input.description,
          isActive: true,
          latestVersionNumber: 1,
          createdBy: input.createdByUserId,
          updatedBy: input.createdByUserId,
        })
        .returning();

      if (!defRow) {
        throw new Error("Failed to create workflow definition record.");
      }

      const [verRow] = await executor
        .insert(workflowDefinitionVersions)
        .values({
          id: input.versionId,
          workflowDefinitionId: defRow.id,
          versionNumber: 1,
          steps: toStepSnapshots(input.steps),
          createdBy: input.createdByUserId,
        })
        .returning();

      if (!verRow) {
        throw new Error("Failed to create initial workflow definition version record.");
      }

      return {
        definition: toWorkflowDefinitionEntity(defRow),
        version: toWorkflowDefinitionVersionEntity(verRow),
      };
    },

    async publishNewVersion(
      input: PublishWorkflowDefinitionVersionInput,
      tx?: TransactionContext,
    ): Promise<CreatedWorkflowDefinitionRecords | null> {
      const executor = resolveDbExecutor(db, tx);
      const nextVersionNumber = input.expectedLatestVersionNumber + 1;

      const [updatedDef] = await executor
        .update(workflowDefinitions)
        .set({
          latestVersionNumber: nextVersionNumber,
          updatedBy: input.createdByUserId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workflowDefinitions.id, input.workflowDefinitionId),
            eq(workflowDefinitions.latestVersionNumber, input.expectedLatestVersionNumber),
          ),
        )
        .returning();

      if (!updatedDef) {
        return null;
      }

      const [verRow] = await executor
        .insert(workflowDefinitionVersions)
        .values({
          id: input.versionId,
          workflowDefinitionId: updatedDef.id,
          versionNumber: nextVersionNumber,
          steps: toStepSnapshots(input.steps),
          createdBy: input.createdByUserId,
        })
        .returning();

      if (!verRow) {
        throw new Error("Failed to insert workflow definition version record.");
      }

      return {
        definition: toWorkflowDefinitionEntity(updatedDef),
        version: toWorkflowDefinitionVersionEntity(verRow),
      };
    },

    async updateMetadata(
      input: UpdateWorkflowDefinitionInput,
      tx?: TransactionContext,
    ): Promise<WorkflowDefinitionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .update(workflowDefinitions)
        .set({
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          updatedBy: input.updatedByUserId,
          updatedAt: new Date(),
        })
        .where(eq(workflowDefinitions.id, input.workflowDefinitionId))
        .returning();

      return row ? toWorkflowDefinitionEntity(row) : null;
    },
  };
}

export function createWorkflowInstanceRepository(
  db: NodePgDatabase,
): WorkflowInstanceRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<WorkflowInstanceEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(workflowInstances)
        .where(eq(workflowInstances.id, id))
        .limit(1);
      return row ? toWorkflowInstanceEntity(row) : null;
    },

    async findActiveByDocumentId(
      documentId: string,
      tx?: TransactionContext,
    ): Promise<WorkflowInstanceEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(workflowInstances)
        .where(
          and(eq(workflowInstances.documentId, documentId), eq(workflowInstances.status, "ACTIVE")),
        )
        .limit(1);
      return row ? toWorkflowInstanceEntity(row) : null;
    },

    async findActiveByDocumentVersionId(
      documentVersionId: string,
      tx?: TransactionContext,
    ): Promise<WorkflowInstanceEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(workflowInstances)
        .where(
          and(
            eq(workflowInstances.documentVersionId, documentVersionId),
            eq(workflowInstances.status, "ACTIVE"),
          ),
        )
        .limit(1);
      return row ? toWorkflowInstanceEntity(row) : null;
    },

    async listByDocumentId(
      documentId: string,
      tx?: TransactionContext,
    ): Promise<readonly WorkflowInstanceEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select()
        .from(workflowInstances)
        .where(eq(workflowInstances.documentId, documentId))
        .orderBy(desc(workflowInstances.startedAt), desc(workflowInstances.id));
      return rows.map(toWorkflowInstanceEntity);
    },

    async create(
      input: CreateWorkflowInstanceRecordInput,
      tx?: TransactionContext,
    ): Promise<WorkflowInstanceEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(workflowInstances)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          workflowDefinitionVersionId: input.workflowDefinitionVersionId,
          status: "ACTIVE",
          currentStepOrder: input.currentStepOrder,
          startedByUserId: input.startedByUserId,
          startedAt: input.startedAt,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to insert workflow instance record.");
      }
      return toWorkflowInstanceEntity(row);
    },

    async updateProgress(
      input: UpdateWorkflowInstanceProgressInput,
      tx?: TransactionContext,
    ): Promise<WorkflowInstanceEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .update(workflowInstances)
        .set({
          status: input.status,
          currentStepOrder: input.currentStepOrder,
          completedAt: input.completedAt,
        })
        .where(
          and(
            eq(workflowInstances.id, input.instanceId),
            eq(workflowInstances.status, input.expectedStatus),
          ),
        )
        .returning();

      return row ? toWorkflowInstanceEntity(row) : null;
    },
  };
}

export function createWorkflowTaskRepository(db: NodePgDatabase): WorkflowTaskRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<WorkflowTaskEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(workflowTasks)
        .where(eq(workflowTasks.id, id))
        .limit(1);
      return row ? toWorkflowTaskEntity(row) : null;
    },

    async findByInstanceAndStep(
      workflowInstanceId: string,
      stepOrder: number,
      tx?: TransactionContext,
    ): Promise<WorkflowTaskEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(workflowTasks)
        .where(
          and(
            eq(workflowTasks.workflowInstanceId, workflowInstanceId),
            eq(workflowTasks.stepOrder, stepOrder),
          ),
        )
        .limit(1);
      return row ? toWorkflowTaskEntity(row) : null;
    },

    async listByInstanceId(
      workflowInstanceId: string,
      tx?: TransactionContext,
    ): Promise<readonly WorkflowTaskEntity[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select()
        .from(workflowTasks)
        .where(eq(workflowTasks.workflowInstanceId, workflowInstanceId))
        .orderBy(asc(workflowTasks.stepOrder), asc(workflowTasks.id));
      return rows.map(toWorkflowTaskEntity);
    },

    async createIdempotent(
      input: CreateWorkflowTaskIdempotentInput,
      tx?: TransactionContext,
    ): Promise<CreateWorkflowTaskRecordResult> {
      const executor = resolveDbExecutor(db, tx);
      const assigneeTargetId =
        input.assignee.type === "USER"
          ? input.assignee.userId
          : input.assignee.type === "GROUP"
            ? input.assignee.groupId
            : input.assignee.roleId;

      const [inserted] = await executor
        .insert(workflowTasks)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          workflowInstanceId: input.workflowInstanceId,
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          stepOrder: input.stepOrder,
          status: "PENDING",
          assigneeType: input.assignee.type,
          assigneeTargetId,
          dueAt: input.dueAt,
        })
        .onConflictDoNothing({
          target: [workflowTasks.workflowInstanceId, workflowTasks.stepOrder],
        })
        .returning();

      if (inserted) {
        return { task: toWorkflowTaskEntity(inserted), created: true };
      }

      const existing = await this.findByInstanceAndStep(
        input.workflowInstanceId,
        input.stepOrder,
        tx,
      );
      if (!existing) {
        throw new Error("Workflow task conflict resolution failed to retrieve existing task.");
      }

      return { task: existing, created: false };
    },

    async transitionFromPending(
      input: TransitionWorkflowTaskFromPendingInput,
      tx?: TransactionContext,
    ): Promise<WorkflowTaskEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [updated] = await executor
        .update(workflowTasks)
        .set({
          status: input.nextStatus,
          decidedAt: input.decidedAt,
        })
        .where(
          and(eq(workflowTasks.id, input.taskId), eq(workflowTasks.status, input.expectedStatus)),
        )
        .returning();

      return updated ? toWorkflowTaskEntity(updated) : null;
    },

    async cancelPendingByInstanceId(
      workflowInstanceId: string,
      cancelledAt: Date,
      tx?: TransactionContext,
    ): Promise<number> {
      const executor = resolveDbExecutor(db, tx);
      const updated = await executor
        .update(workflowTasks)
        .set({
          status: "CANCELLED",
          decidedAt: cancelledAt,
        })
        .where(
          and(
            eq(workflowTasks.workflowInstanceId, workflowInstanceId),
            eq(workflowTasks.status, "PENDING"),
          ),
        )
        .returning({ id: workflowTasks.id });

      return updated.length;
    },
  };
}

export function createWorkflowDecisionRepository(
  db: NodePgDatabase,
): WorkflowDecisionRepositoryPort {
  return {
    async findByTaskId(
      taskId: string,
      tx?: TransactionContext,
    ): Promise<WorkflowDecisionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(workflowDecisions)
        .where(eq(workflowDecisions.taskId, taskId))
        .limit(1);

      if (!row) {
        return null;
      }

      return {
        id: row.id,
        taskId: row.taskId,
        actorUserId: row.actorUserId,
        decision: row.decision,
        comment: row.comment,
        createdAt: row.createdAt.toISOString(),
      };
    },

    async create(
      input: CreateWorkflowDecisionRecordInput,
      tx?: TransactionContext,
    ): Promise<WorkflowDecisionEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(workflowDecisions)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          taskId: input.taskId,
          actorUserId: input.actorUserId,
          decision: input.decision,
          comment: input.comment,
          createdAt: input.createdAt,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to insert workflow decision record.");
      }

      return {
        id: row.id,
        taskId: row.taskId,
        actorUserId: row.actorUserId,
        decision: row.decision,
        comment: row.comment,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    },
  };
}

function scopeMatchesDocument(
  scope: AccessScope,
  documentId: string,
  categoryId: string,
  folderAncestorIds: ReadonlySet<string>,
): boolean {
  switch (scope.type) {
    case "GLOBAL":
      return true;
    case "DOCUMENT":
      return scope.documentId === documentId;
    case "CATEGORY":
      return scope.categoryId === categoryId;
    case "FOLDER":
      return folderAncestorIds.has(scope.folderId);
  }
}

function toAccessScope(
  scopeType: "GLOBAL" | "CATEGORY" | "FOLDER" | "DOCUMENT",
  targetId: string | null,
): AccessScope | null {
  switch (scopeType) {
    case "GLOBAL":
      return { type: "GLOBAL" };
    case "CATEGORY":
      return targetId ? { type: "CATEGORY", categoryId: targetId } : null;
    case "FOLDER":
      return targetId ? { type: "FOLDER", folderId: targetId } : null;
    case "DOCUMENT":
      return targetId ? { type: "DOCUMENT", documentId: targetId } : null;
  }
}

/**
 * Verifies in PostgreSQL that the workflow step's assignee target (user, group, or role)
 * belongs to the organization, is active, and holds non-denied authorization for the document.
 */
export function createWorkflowAssigneeVerifier(
  db: NodePgDatabase,
): WorkflowAssigneeAuthorizationPort {
  const loadFolderAncestors = async (
    executor: ReturnType<typeof resolveDbExecutor>,
    organizationId: string,
    folderId: string | null,
  ): Promise<ReadonlySet<string>> => {
    const ancestors = new Set<string>();
    let current = folderId;
    let guard = 0;
    while (current !== null && guard < 128) {
      guard += 1;
      if (ancestors.has(current)) {
        break;
      }
      ancestors.add(current);
      const [row] = await executor
        .select({ parentId: folders.parentId })
        .from(folders)
        .where(and(eq(folders.id, current), eq(folders.organizationId, organizationId)))
        .limit(1);
      if (!row) {
        break;
      }
      current = row.parentId;
    }
    return ancestors;
  };

  return {
    async assertAssigneeAuthorizedForDocument(
      input: {
        readonly organizationId: string;
        readonly documentId: string;
        readonly assignee: WorkflowAssigneeTarget;
      },
      tx?: TransactionContext,
    ): Promise<void> {
      const executor = resolveDbExecutor(db, tx);

      const [doc] = await executor
        .select({
          id: documents.id,
          organizationId: documents.organizationId,
          categoryId: documents.categoryId,
          folderId: documents.folderId,
          status: documents.status,
        })
        .from(documents)
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(documents.organizationId, input.organizationId),
          ),
        )
        .limit(1);

      if (!doc || doc.status === "DELETED") {
        throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
      }

      const folderAncestors = await loadFolderAncestors(
        executor,
        input.organizationId,
        doc.folderId,
      );

      const isUserAuthorizedForDoc = async (userId: string): Promise<boolean> => {
        const groupRows = await executor
          .select({ groupId: userGroups.groupId })
          .from(userGroups)
          .where(eq(userGroups.userId, userId));
        const memberGroupIds = groupRows.map((g) => g.groupId);

        const subjectFilter =
          memberGroupIds.length > 0
            ? or(eq(userRoleScopes.userId, userId), inArray(userRoleScopes.groupId, memberGroupIds))
            : eq(userRoleScopes.userId, userId);

        const assignmentRows = await executor
          .select({
            roleId: userRoleScopes.roleId,
            scopeType: userRoleScopes.scopeType,
            scopeTargetId: userRoleScopes.scopeTargetId,
            effect: userRoleScopes.effect,
            action: permissions.action,
            resource: permissions.resource,
          })
          .from(userRoleScopes)
          .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoleScopes.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(and(eq(userRoleScopes.organizationId, input.organizationId), subjectFilter));

        let hasAllow = false;
        for (const row of assignmentRows) {
          const isReviewCapability =
            (row.action === "APPROVE" && row.resource === "WORKFLOW") ||
            (row.action === "READ" && row.resource === "DOCUMENT");
          if (!isReviewCapability) {
            continue;
          }
          const scope = toAccessScope(row.scopeType, row.scopeTargetId);
          if (!scope || !scopeMatchesDocument(scope, doc.id, doc.categoryId, folderAncestors)) {
            continue;
          }
          if (row.effect === "DENY") {
            return false;
          }
          hasAllow = true;
        }
        return hasAllow;
      };

      if (input.assignee.type === "USER") {
        const [userRow] = await executor
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(
            and(
              eq(users.id, input.assignee.userId),
              eq(users.organizationId, input.organizationId),
            ),
          )
          .limit(1);

        if (!userRow || userRow.status !== "ACTIVE") {
          throw new DomainError(
            "WORKFLOW_ASSIGNEE_NOT_FOUND",
            "Usuário aprovador não encontrado ou inativo nesta organização.",
          );
        }

        const allowed = await isUserAuthorizedForDoc(userRow.id);
        if (!allowed) {
          throw new DomainError(
            "WORKFLOW_ASSIGNEE_UNAUTHORIZED",
            "Usuário atribuído não possui permissão de leitura/aprovação para este documento.",
          );
        }
        return;
      }

      if (input.assignee.type === "GROUP") {
        const [groupRow] = await executor
          .select({ id: groups.id })
          .from(groups)
          .where(
            and(
              eq(groups.id, input.assignee.groupId),
              eq(groups.organizationId, input.organizationId),
            ),
          )
          .limit(1);

        if (!groupRow) {
          throw new DomainError(
            "WORKFLOW_ASSIGNEE_NOT_FOUND",
            "Grupo aprovador não encontrado nesta organização.",
          );
        }

        const activeMembers = await executor
          .select({ userId: users.id })
          .from(userGroups)
          .innerJoin(users, eq(users.id, userGroups.userId))
          .where(
            and(
              eq(userGroups.groupId, groupRow.id),
              eq(users.organizationId, input.organizationId),
              eq(users.status, "ACTIVE"),
            ),
          );

        if (activeMembers.length === 0) {
          throw new DomainError(
            "WORKFLOW_ASSIGNEE_UNAUTHORIZED",
            "O grupo aprovador não possui membros ativos na organização.",
          );
        }

        for (const member of activeMembers) {
          if (await isUserAuthorizedForDoc(member.userId)) {
            return;
          }
        }

        throw new DomainError(
          "WORKFLOW_ASSIGNEE_UNAUTHORIZED",
          "Nenhum membro ativo do grupo possui permissão autorizada para revisar este documento.",
        );
      }

      // ROLE assignee
      const [roleRow] = await executor
        .select({ id: roles.id })
        .from(roles)
        .where(
          and(eq(roles.id, input.assignee.roleId), eq(roles.organizationId, input.organizationId)),
        )
        .limit(1);

      if (!roleRow) {
        throw new DomainError(
          "WORKFLOW_ASSIGNEE_NOT_FOUND",
          "Papel aprovador não encontrado nesta organização.",
        );
      }

      const rolePerms = await executor
        .select({ action: permissions.action, resource: permissions.resource })
        .from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(eq(rolePermissions.roleId, roleRow.id));

      const hasApprovalCapability = rolePerms.some(
        (p) =>
          (p.action === "APPROVE" && p.resource === "WORKFLOW") ||
          (p.action === "READ" && p.resource === "DOCUMENT"),
      );
      if (!hasApprovalCapability) {
        throw new DomainError(
          "WORKFLOW_ASSIGNEE_UNAUTHORIZED",
          "O papel informado não possui permissão de aprovação ou leitura documental.",
        );
      }

      const activeRoleScopes = await executor
        .select({
          scopeType: userRoleScopes.scopeType,
          scopeTargetId: userRoleScopes.scopeTargetId,
          effect: userRoleScopes.effect,
        })
        .from(userRoleScopes)
        .where(
          and(
            eq(userRoleScopes.organizationId, input.organizationId),
            eq(userRoleScopes.roleId, roleRow.id),
            eq(userRoleScopes.effect, "ALLOW"),
          ),
        );

      const hasMatchingHolder = activeRoleScopes.some((row) => {
        const scope = toAccessScope(row.scopeType, row.scopeTargetId);
        return scope ? scopeMatchesDocument(scope, doc.id, doc.categoryId, folderAncestors) : false;
      });

      if (!hasMatchingHolder) {
        throw new DomainError(
          "WORKFLOW_ASSIGNEE_UNAUTHORIZED",
          "O papel informado não possui atribuição ativa no escopo deste documento.",
        );
      }
    },
  };
}
