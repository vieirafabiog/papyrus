import { DomainError } from "../../index.js";
import type { AuditRepositoryPort } from "../../ports/audit-repository.port.js";
import type { TransactionManagerPort } from "../../ports/transaction.port.js";
import type {
  CreatedWorkflowDefinitionRecords,
  WorkflowDefinitionRepositoryPort,
} from "../../ports/workflow-definition-repository.port.js";
import type {
  WorkflowAssigneeTarget,
  WorkflowDefinitionEntity,
  WorkflowDefinitionVersionEntity,
} from "../workflow.types.js";
import {
  type WorkflowStepDefinitionInput,
  normalizeWorkflowDefinitionDescription,
  normalizeWorkflowDefinitionName,
  validateSequentialWorkflowSteps,
} from "./validation.js";

export interface WorkflowDefinitionServiceDependencies {
  readonly definitions: WorkflowDefinitionRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
  readonly validateAssigneeTarget?: (
    organizationId: string,
    assignee: WorkflowAssigneeTarget,
  ) => Promise<void>;
}

export interface CreateWorkflowDefinitionCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly steps: readonly WorkflowStepDefinitionInput[];
}

export interface PublishWorkflowDefinitionVersionCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly workflowDefinitionId: string;
  readonly steps: readonly WorkflowStepDefinitionInput[];
}

export interface UpdateWorkflowDefinitionStatusCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly workflowDefinitionId: string;
  readonly isActive: boolean;
}

export interface WorkflowDefinitionWithVersions {
  readonly definition: WorkflowDefinitionEntity;
  readonly versions: readonly WorkflowDefinitionVersionEntity[];
}

export interface WorkflowDefinitionService {
  createDefinition(
    command: CreateWorkflowDefinitionCommand,
  ): Promise<CreatedWorkflowDefinitionRecords>;
  publishNewVersion(
    command: PublishWorkflowDefinitionVersionCommand,
  ): Promise<CreatedWorkflowDefinitionRecords>;
  setActiveStatus(
    command: UpdateWorkflowDefinitionStatusCommand,
  ): Promise<WorkflowDefinitionEntity>;
  getDefinitionWithVersions(
    organizationId: string,
    workflowDefinitionId: string,
  ): Promise<WorkflowDefinitionWithVersions>;
}

/**
 * Creates the domain service managing versioned sequential workflow definitions.
 * Published versions are immutable snapshots so in-flight workflow instances
 * are never altered retroactively.
 */
export function createWorkflowDefinitionService(
  deps: WorkflowDefinitionServiceDependencies,
): WorkflowDefinitionService {
  const validateTargets = async (
    organizationId: string,
    steps: ReturnType<typeof validateSequentialWorkflowSteps>,
  ): Promise<void> => {
    if (!deps.validateAssigneeTarget) {
      return;
    }
    for (const step of steps) {
      await deps.validateAssigneeTarget(organizationId, step.assignee);
    }
  };

  return {
    async createDefinition(
      command: CreateWorkflowDefinitionCommand,
    ): Promise<CreatedWorkflowDefinitionRecords> {
      const normalizedName = normalizeWorkflowDefinitionName(command.name);
      const normalizedDescription = normalizeWorkflowDefinitionDescription(command.description);
      const validatedSteps = validateSequentialWorkflowSteps(command.steps);

      await validateTargets(command.organizationId, validatedSteps);

      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.definitions.findByName(
          command.organizationId,
          normalizedName,
          tx,
        );
        if (existing) {
          throw new DomainError(
            "WORKFLOW_DEFINITION_NAME_IN_USE",
            "Já existe uma definição de fluxo com este nome nesta organização.",
          );
        }

        const created = await deps.definitions.createWithInitialVersion(
          {
            definitionId: deps.generateId(),
            versionId: deps.generateId(),
            organizationId: command.organizationId,
            name: normalizedName,
            description: normalizedDescription,
            steps: validatedSteps,
            createdByUserId: command.actorUserId,
          },
          tx,
        );

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "WORKFLOW_DEFINITION_CREATED",
            resourceType: "WORKFLOW_DEFINITION",
            resourceId: created.definition.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              versionId: created.version.id,
              versionNumber: created.version.versionNumber,
              stepCount: validatedSteps.length,
            },
          },
          tx,
        );

        return created;
      });
    },

    async publishNewVersion(
      command: PublishWorkflowDefinitionVersionCommand,
    ): Promise<CreatedWorkflowDefinitionRecords> {
      const validatedSteps = validateSequentialWorkflowSteps(command.steps);
      await validateTargets(command.organizationId, validatedSteps);

      return deps.transactions.runInTransaction(async (tx) => {
        const definition = await deps.definitions.findById(command.workflowDefinitionId, tx);
        if (!definition || definition.organizationId !== command.organizationId) {
          throw new DomainError(
            "WORKFLOW_DEFINITION_NOT_FOUND",
            "Definição de fluxo não encontrada.",
          );
        }
        if (!definition.isActive) {
          throw new DomainError(
            "WORKFLOW_DEFINITION_INACTIVE",
            "Não é possível publicar nova versão para uma definição de fluxo desativada.",
          );
        }

        const published = await deps.definitions.publishNewVersion(
          {
            workflowDefinitionId: definition.id,
            versionId: deps.generateId(),
            expectedLatestVersionNumber: definition.latestVersionNumber,
            steps: validatedSteps,
            createdByUserId: command.actorUserId,
          },
          tx,
        );

        if (!published) {
          throw new DomainError(
            "WORKFLOW_DEFINITION_VERSION_CONFLICT",
            "A definição de fluxo foi atualizada simultaneamente; tente novamente.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "WORKFLOW_DEFINITION_VERSION_PUBLISHED",
            resourceType: "WORKFLOW_DEFINITION",
            resourceId: published.definition.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              versionId: published.version.id,
              versionNumber: published.version.versionNumber,
              stepCount: validatedSteps.length,
            },
          },
          tx,
        );

        return published;
      });
    },

    async setActiveStatus(
      command: UpdateWorkflowDefinitionStatusCommand,
    ): Promise<WorkflowDefinitionEntity> {
      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.definitions.findById(command.workflowDefinitionId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError(
            "WORKFLOW_DEFINITION_NOT_FOUND",
            "Definição de fluxo não encontrada.",
          );
        }

        if (existing.isActive === command.isActive) {
          return existing;
        }

        const updated = await deps.definitions.updateMetadata(
          {
            workflowDefinitionId: existing.id,
            isActive: command.isActive,
            updatedByUserId: command.actorUserId,
          },
          tx,
        );

        if (!updated) {
          throw new DomainError(
            "WORKFLOW_DEFINITION_NOT_FOUND",
            "Definição de fluxo não encontrada.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "WORKFLOW_DEFINITION_STATUS_CHANGED",
            resourceType: "WORKFLOW_DEFINITION",
            resourceId: updated.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              isActive: updated.isActive,
            },
          },
          tx,
        );

        return updated;
      });
    },

    async getDefinitionWithVersions(
      organizationId: string,
      workflowDefinitionId: string,
    ): Promise<WorkflowDefinitionWithVersions> {
      const definition = await deps.definitions.findById(workflowDefinitionId);
      if (!definition || definition.organizationId !== organizationId) {
        throw new DomainError(
          "WORKFLOW_DEFINITION_NOT_FOUND",
          "Definição de fluxo não encontrada.",
        );
      }

      const versions = await deps.definitions.listVersions(definition.id);
      return { definition, versions };
    },
  };
}
