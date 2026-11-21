import type {
  WorkflowDefinitionEntity,
  WorkflowDefinitionVersionEntity,
  WorkflowStepDefinition,
} from "../workflows/workflow.types.js";
import type { TransactionContext } from "./transaction.port.js";

export interface CreateWorkflowDefinitionRecordInput {
  readonly definitionId: string;
  readonly versionId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly steps: readonly WorkflowStepDefinition[];
  readonly createdByUserId: string;
}

export interface CreatedWorkflowDefinitionRecords {
  readonly definition: WorkflowDefinitionEntity;
  readonly version: WorkflowDefinitionVersionEntity;
}

export interface PublishWorkflowDefinitionVersionInput {
  readonly workflowDefinitionId: string;
  readonly versionId: string;
  readonly expectedLatestVersionNumber: number;
  readonly steps: readonly WorkflowStepDefinition[];
  readonly createdByUserId: string;
}

export interface UpdateWorkflowDefinitionInput {
  readonly workflowDefinitionId: string;
  readonly isActive?: boolean | undefined;
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly updatedByUserId: string;
}

export interface WorkflowDefinitionRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<WorkflowDefinitionEntity | null>;
  findByName(
    organizationId: string,
    name: string,
    tx?: TransactionContext,
  ): Promise<WorkflowDefinitionEntity | null>;
  listByOrganization(
    organizationId: string,
    options?: { readonly activeOnly?: boolean | undefined },
    tx?: TransactionContext,
  ): Promise<readonly WorkflowDefinitionEntity[]>;
  findVersionById(
    versionId: string,
    tx?: TransactionContext,
  ): Promise<WorkflowDefinitionVersionEntity | null>;
  findVersionByNumber(
    workflowDefinitionId: string,
    versionNumber: number,
    tx?: TransactionContext,
  ): Promise<WorkflowDefinitionVersionEntity | null>;
  listVersions(
    workflowDefinitionId: string,
    tx?: TransactionContext,
  ): Promise<readonly WorkflowDefinitionVersionEntity[]>;
  createWithInitialVersion(
    input: CreateWorkflowDefinitionRecordInput,
    tx?: TransactionContext,
  ): Promise<CreatedWorkflowDefinitionRecords>;
  publishNewVersion(
    input: PublishWorkflowDefinitionVersionInput,
    tx?: TransactionContext,
  ): Promise<CreatedWorkflowDefinitionRecords | null>;
  updateMetadata(
    input: UpdateWorkflowDefinitionInput,
    tx?: TransactionContext,
  ): Promise<WorkflowDefinitionEntity | null>;
}
