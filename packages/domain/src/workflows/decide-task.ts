import { createAuditWriter } from "../audit/audit-writer.js";
import type { DocumentEntity } from "../documents/document.types.js";
import { assertApprovalMatchesVersion } from "../documents/versioning.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { DocumentRepositoryPort } from "../ports/document-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import type { WorkflowDefinitionRepositoryPort } from "../ports/workflow-definition-repository.port.js";
import type { WorkflowInstanceRepositoryPort } from "../ports/workflow-instance-repository.port.js";
import type {
  WorkflowDecisionRepositoryPort,
  WorkflowTaskRepositoryPort,
} from "../ports/workflow-task-repository.port.js";
import { validateDecisionComment } from "./definitions/validation.js";
import {
  type WorkflowAssigneeTarget,
  type WorkflowDecisionEntity,
  type WorkflowDecisionType,
  type WorkflowInstanceEntity,
  type WorkflowInstanceStatus,
  type WorkflowStepDefinition,
  type WorkflowTaskEntity,
  type WorkflowTaskStatus,
  isTerminalTaskStatus,
} from "./workflow.types.js";

export type DecideTaskAction = WorkflowDecisionType | "CANCEL";

export interface DecideTaskDependencies {
  readonly tasks: WorkflowTaskRepositoryPort;
  readonly decisions: WorkflowDecisionRepositoryPort;
  readonly workflowInstances: WorkflowInstanceRepositoryPort;
  readonly definitions: WorkflowDefinitionRepositoryPort;
  readonly documents: DocumentRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
  readonly now?: (() => Date) | undefined;
}

export interface DecideTaskCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorGroupIds?: readonly string[] | undefined;
  readonly actorRoleIds?: readonly string[] | undefined;
  readonly allowAdminCancel?: boolean | undefined;
  readonly requestId: string;
  readonly taskId: string;
  readonly action: DecideTaskAction;
  readonly comment?: string | null | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface DecidedTaskResult {
  readonly task: WorkflowTaskEntity;
  readonly decision: WorkflowDecisionEntity | null;
  readonly instance: WorkflowInstanceEntity;
  readonly document: DocumentEntity;
  readonly nextStep: WorkflowStepDefinition | null;
  readonly idempotentReplay: boolean;
}

export interface DecideTaskService {
  decideTask(command: DecideTaskCommand): Promise<DecidedTaskResult>;
}

function isActorAssignedToTarget(
  assignee: WorkflowAssigneeTarget,
  command: DecideTaskCommand,
): boolean {
  switch (assignee.type) {
    case "USER":
      return assignee.userId === command.actorUserId;
    case "GROUP":
      return (command.actorGroupIds ?? []).includes(assignee.groupId);
    case "ROLE":
      return (command.actorRoleIds ?? []).includes(assignee.roleId);
  }
}

function mapActionToTaskStatus(action: DecideTaskAction): WorkflowTaskStatus {
  switch (action) {
    case "APPROVE":
      return "APPROVED";
    case "REJECT":
      return "REJECTED";
    case "REQUEST_CHANGES":
      return "CHANGES_REQUESTED";
    case "CANCEL":
      return "CANCELLED";
  }
}

function resolveNextInstanceStatus(
  action: DecideTaskAction,
  hasNextStep: boolean,
): WorkflowInstanceStatus {
  switch (action) {
    case "APPROVE":
      return hasNextStep ? "ACTIVE" : "COMPLETED";
    case "REJECT":
      return "REJECTED";
    case "REQUEST_CHANGES":
      return "CHANGES_REQUESTED";
    case "CANCEL":
      return "CANCELLED";
  }
}

function isMatchingIdempotentDecisionReplay(params: {
  readonly task: WorkflowTaskEntity;
  readonly existingDecision: WorkflowDecisionEntity | null;
  readonly command: DecideTaskCommand;
  readonly normalizedComment: string | null;
}): boolean {
  const { task, existingDecision, command, normalizedComment } = params;

  if (command.action === "CANCEL") {
    return task.status === "CANCELLED";
  }

  if (task.status !== mapActionToTaskStatus(command.action) || !existingDecision) {
    return false;
  }

  if (
    existingDecision.actorUserId !== command.actorUserId ||
    existingDecision.decision !== command.action ||
    (existingDecision.comment ?? null) !== (normalizedComment ?? null)
  ) {
    return false;
  }

  if (
    command.idempotencyKey !== undefined &&
    existingDecision.idempotencyKey !== undefined &&
    existingDecision.idempotencyKey !== null
  ) {
    return existingDecision.idempotencyKey === command.idempotencyKey;
  }

  return true;
}

/**
 * Executes approve, reject, request-changes, and cancel decisions atomically inside
 * a transaction with optimistic status transition (`PENDING -> terminal`), strict
 * document version binding, mandatory comment enforcement, and idempotent replay
 * when the exact same decision request is retried.
 */
export function createDecideTaskUseCase(deps: DecideTaskDependencies): DecideTaskService {
  const now = deps.now ?? (() => new Date());
  const auditWriter = createAuditWriter({ repository: deps.audit });

  return {
    async decideTask(command: DecideTaskCommand): Promise<DecidedTaskResult> {
      const decidedAt = now();

      return deps.transactions.runInTransaction(async (tx) => {
        const task = await deps.tasks.findById(command.taskId, tx);
        if (!task) {
          throw new DomainError("WORKFLOW_TASK_NOT_FOUND", "Tarefa não encontrada.");
        }

        const doc = await deps.documents.findById(task.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId || doc.status === "DELETED") {
          throw new DomainError("WORKFLOW_TASK_NOT_FOUND", "Tarefa não encontrada.");
        }

        const instance = await deps.workflowInstances.findById(task.workflowInstanceId, tx);
        if (!instance || instance.documentId !== doc.id) {
          throw new DomainError(
            "WORKFLOW_INSTANCE_NOT_FOUND",
            "Instância de fluxo associada à tarefa não foi encontrada.",
          );
        }

        const canCancelAsInitiatorOrAdmin =
          command.action === "CANCEL" &&
          (instance.startedByUserId === command.actorUserId || Boolean(command.allowAdminCancel));

        if (!isActorAssignedToTarget(task.assignee, command) && !canCancelAsInitiatorOrAdmin) {
          throw new DomainError(
            "TASK_DECISION_FORBIDDEN",
            "Você não possui permissão para decidir ou cancelar esta tarefa.",
          );
        }

        const definitionVersion = await deps.definitions.findVersionById(
          instance.workflowDefinitionVersionId,
          tx,
        );
        if (!definitionVersion) {
          throw new DomainError(
            "WORKFLOW_DEFINITION_VERSION_NOT_FOUND",
            "Versão da definição de fluxo não encontrada.",
          );
        }

        const currentStep = definitionVersion.steps.find(
          (item) => item.stepOrder === task.stepOrder,
        );
        if (!currentStep) {
          throw new DomainError(
            "WORKFLOW_STEP_NOT_FOUND",
            "Etapa correspondente à tarefa não encontrada na definição do fluxo.",
          );
        }

        const normalizedComment =
          command.action === "CANCEL"
            ? command.comment && command.comment.trim().length > 0
              ? command.comment.trim()
              : null
            : validateDecisionComment(currentStep, command.action, command.comment);

        // Idempotent replay / terminal conflict handling
        if (isTerminalTaskStatus(task.status)) {
          const existingDecision = await deps.decisions.findByTaskId(task.id, tx);
          if (
            isMatchingIdempotentDecisionReplay({
              task,
              existingDecision,
              command,
              normalizedComment,
            })
          ) {
            return {
              task,
              decision: existingDecision,
              instance,
              document: doc,
              nextStep: null,
              idempotentReplay: true,
            };
          }

          throw new DomainError(
            "TASK_ALREADY_DECIDED",
            "Esta tarefa já recebeu uma decisão final anteriormente.",
          );
        }

        if (instance.status !== "ACTIVE") {
          throw new DomainError(
            "WORKFLOW_INSTANCE_NOT_ACTIVE",
            "A instância de fluxo desta tarefa não está mais ativa.",
          );
        }

        if (command.action !== "CANCEL") {
          // Ensure workflow is still acting on the exact pinned version & not silently approving a newer upload
          assertApprovalMatchesVersion(
            instance,
            doc,
            doc.currentVersionId ?? task.documentVersionId,
          );
        }

        const nextTaskStatus = mapActionToTaskStatus(command.action);
        const transitionedTask = await deps.tasks.transitionFromPending(
          {
            taskId: task.id,
            expectedStatus: "PENDING",
            nextStatus: nextTaskStatus,
            decidedAt,
          },
          tx,
        );

        // Concurrent decision winner check
        if (!transitionedTask) {
          const latestTask = await deps.tasks.findById(task.id, tx);
          const latestDecision = await deps.decisions.findByTaskId(task.id, tx);
          const latestInstance =
            (await deps.workflowInstances.findById(instance.id, tx)) ?? instance;
          const latestDoc = (await deps.documents.findById(doc.id, tx)) ?? doc;

          if (
            latestTask &&
            isMatchingIdempotentDecisionReplay({
              task: latestTask,
              existingDecision: latestDecision,
              command,
              normalizedComment,
            })
          ) {
            return {
              task: latestTask,
              decision: latestDecision,
              instance: latestInstance,
              document: latestDoc,
              nextStep: null,
              idempotentReplay: true,
            };
          }

          throw new DomainError(
            "TASK_DECISION_CONFLICT",
            "Conflito concorrente: esta tarefa foi decidida simultaneamente por outro usuário.",
          );
        }

        let createdDecision: WorkflowDecisionEntity | null = null;
        if (command.action !== "CANCEL") {
          createdDecision = await deps.decisions.create(
            {
              id: deps.generateId(),
              organizationId: command.organizationId,
              taskId: transitionedTask.id,
              actorUserId: command.actorUserId,
              decision: command.action,
              comment: normalizedComment,
              idempotencyKey: command.idempotencyKey ?? null,
              createdAt: decidedAt,
            },
            tx,
          );
        } else {
          await deps.tasks.cancelPendingByInstanceId(instance.id, decidedAt, tx);
        }

        const sortedSteps = [...definitionVersion.steps].sort((a, b) => a.stepOrder - b.stepOrder);
        const nextStep =
          command.action === "APPROVE"
            ? (sortedSteps.find((s) => s.stepOrder > transitionedTask.stepOrder) ?? null)
            : null;

        const nextInstanceStatus = resolveNextInstanceStatus(command.action, nextStep !== null);
        const nextStepOrder = nextStep ? nextStep.stepOrder : instance.currentStepOrder;
        const completedAt = nextInstanceStatus === "ACTIVE" ? null : decidedAt;

        const updatedInstance = await deps.workflowInstances.updateProgress(
          {
            instanceId: instance.id,
            expectedStatus: "ACTIVE",
            status: nextInstanceStatus,
            currentStepOrder: nextStepOrder,
            completedAt,
          },
          tx,
        );
        if (!updatedInstance) {
          throw new DomainError(
            "WORKFLOW_INSTANCE_CONFLICT",
            "Conflito ao atualizar o estado da instância de fluxo.",
          );
        }

        let finalDocument = doc;
        if (nextInstanceStatus === "COMPLETED") {
          const updated = await deps.documents.updateStatus(doc.id, "APPROVED", doc.version, tx);
          if (!updated) {
            throw new DomainError(
              "DOCUMENT_VERSION_CONFLICT",
              "Conflito ao atualizar o status do documento após aprovação final.",
            );
          }
          finalDocument = updated;
        } else if (nextInstanceStatus === "REJECTED") {
          const updated = await deps.documents.updateStatus(doc.id, "REJECTED", doc.version, tx);
          if (!updated) {
            throw new DomainError(
              "DOCUMENT_VERSION_CONFLICT",
              "Conflito ao atualizar o status do documento após rejeição.",
            );
          }
          finalDocument = updated;
        } else if (
          (nextInstanceStatus === "CHANGES_REQUESTED" || nextInstanceStatus === "CANCELLED") &&
          doc.status === "IN_REVIEW"
        ) {
          const updated = await deps.documents.updateStatus(doc.id, "DRAFT", doc.version, tx);
          if (!updated) {
            throw new DomainError(
              "DOCUMENT_VERSION_CONFLICT",
              "Conflito ao retornar o documento para rascunho.",
            );
          }
          finalDocument = updated;
        }

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action:
              command.action === "CANCEL" ? "WORKFLOW_TASK_CANCELLED" : "WORKFLOW_TASK_DECIDED",
            resourceType: "WORKFLOW_TASK",
            resourceId: transitionedTask.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              workflowInstanceId: updatedInstance.id,
              documentId: finalDocument.id,
              documentVersionId: instance.documentVersionId,
              stepOrder: transitionedTask.stepOrder,
              action: command.action,
              nextInstanceStatus: updatedInstance.status,
            },
          },
          tx,
        );

        return {
          task: transitionedTask,
          decision: createdDecision,
          instance: updatedInstance,
          document: finalDocument,
          nextStep,
          idempotentReplay: false,
        };
      });
    },
  };
}
