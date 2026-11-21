import { createAuditWriter } from "../audit/audit-writer.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { DocumentRepositoryPort } from "../ports/document-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import type { WorkflowDefinitionRepositoryPort } from "../ports/workflow-definition-repository.port.js";
import type { WorkflowInstanceRepositoryPort } from "../ports/workflow-instance-repository.port.js";
import type { WorkflowTaskRepositoryPort } from "../ports/workflow-task-repository.port.js";
import { calculateStepDueAt } from "./definitions/validation.js";
import type { WorkflowAssigneeTarget, WorkflowTaskEntity } from "./workflow.types.js";

export interface WorkflowAssigneeAuthorizationPort {
  assertAssigneeAuthorizedForDocument(
    input: {
      readonly organizationId: string;
      readonly documentId: string;
      readonly assignee: WorkflowAssigneeTarget;
    },
    tx?: TransactionContext,
  ): Promise<void>;
}

export interface CreateWorkflowTasksDependencies {
  readonly workflowInstances: WorkflowInstanceRepositoryPort;
  readonly definitions: WorkflowDefinitionRepositoryPort;
  readonly documents: DocumentRepositoryPort;
  readonly tasks: WorkflowTaskRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
  readonly assigneeAuthorization?: WorkflowAssigneeAuthorizationPort | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface GenerateWorkflowStepTaskCommand {
  readonly organizationId: string;
  readonly actorUserId?: string | null | undefined;
  readonly requestId: string;
  readonly workflowInstanceId: string;
  readonly stepOrder?: number | undefined;
}

export interface GeneratedWorkflowTaskResult {
  readonly task: WorkflowTaskEntity;
  readonly created: boolean;
}

export interface CreateWorkflowTasksService {
  generateTaskForStep(
    command: GenerateWorkflowStepTaskCommand,
  ): Promise<GeneratedWorkflowTaskResult>;
}

/**
 * Generates workflow tasks for authorized users, groups, or roles idempotently so
 * job retries and concurrent calls never duplicate tasks for the same step.
 */
export function createWorkflowTasksUseCase(
  deps: CreateWorkflowTasksDependencies,
): CreateWorkflowTasksService {
  const now = deps.now ?? (() => new Date());
  const auditWriter = createAuditWriter({ repository: deps.audit });

  return {
    async generateTaskForStep(
      command: GenerateWorkflowStepTaskCommand,
    ): Promise<GeneratedWorkflowTaskResult> {
      const referenceNow = now();

      return deps.transactions.runInTransaction(async (tx) => {
        const instance = await deps.workflowInstances.findById(command.workflowInstanceId, tx);
        if (!instance) {
          throw new DomainError(
            "WORKFLOW_INSTANCE_NOT_FOUND",
            "Instância de fluxo de aprovação não encontrada.",
          );
        }

        const doc = await deps.documents.findById(instance.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId) {
          throw new DomainError(
            "WORKFLOW_INSTANCE_NOT_FOUND",
            "Instância de fluxo de aprovação não encontrada.",
          );
        }

        if (instance.status !== "ACTIVE") {
          throw new DomainError(
            "WORKFLOW_INSTANCE_NOT_ACTIVE",
            "Não é possível gerar tarefas para uma instância de fluxo encerrada.",
          );
        }

        const definitionVersion = await deps.definitions.findVersionById(
          instance.workflowDefinitionVersionId,
          tx,
        );
        if (!definitionVersion) {
          throw new DomainError(
            "WORKFLOW_DEFINITION_VERSION_NOT_FOUND",
            "Versão da definição de fluxo vinculada não foi encontrada.",
          );
        }

        const targetStepOrder = command.stepOrder ?? instance.currentStepOrder;
        const step = definitionVersion.steps.find((item) => item.stepOrder === targetStepOrder);
        if (!step) {
          throw new DomainError(
            "WORKFLOW_STEP_NOT_FOUND",
            `Etapa ${targetStepOrder} não existe na definição versionada do fluxo.`,
          );
        }

        const existingTask = await deps.tasks.findByInstanceAndStep(
          instance.id,
          step.stepOrder,
          tx,
        );
        if (existingTask) {
          return {
            task: existingTask,
            created: false,
          };
        }

        if (deps.assigneeAuthorization) {
          await deps.assigneeAuthorization.assertAssigneeAuthorizedForDocument(
            {
              organizationId: command.organizationId,
              documentId: doc.id,
              assignee: step.assignee,
            },
            tx,
          );
        }

        const dueAtIso = calculateStepDueAt(referenceNow, step.dueDays);
        const result = await deps.tasks.createIdempotent(
          {
            id: deps.generateId(),
            organizationId: command.organizationId,
            workflowInstanceId: instance.id,
            documentId: doc.id,
            documentVersionId: instance.documentVersionId,
            stepOrder: step.stepOrder,
            assignee: step.assignee,
            dueAt: dueAtIso ? new Date(dueAtIso) : null,
          },
          tx,
        );

        if (result.created) {
          await auditWriter.write(
            {
              organizationId: command.organizationId,
              actorUserId: command.actorUserId ?? null,
              action: "WORKFLOW_TASK_CREATED",
              resourceType: "WORKFLOW_TASK",
              resourceId: result.task.id,
              result: "SUCCESS",
              requestId: command.requestId,
              metadata: {
                workflowInstanceId: instance.id,
                documentId: doc.id,
                documentVersionId: instance.documentVersionId,
                stepOrder: step.stepOrder,
                assigneeType: step.assignee.type,
              },
            },
            tx,
          );
        }

        return result;
      });
    },
  };
}
