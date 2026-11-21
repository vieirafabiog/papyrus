import type {
  WorkflowInstanceEntity,
  WorkflowInstanceStatus,
} from "../workflows/workflow.types.js";
import type { TransactionContext } from "./transaction.port.js";

export interface CreateWorkflowInstanceRecordInput {
  readonly id: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly workflowDefinitionVersionId: string;
  readonly currentStepOrder: number;
  readonly startedByUserId: string;
  readonly startedAt: Date;
}

export interface UpdateWorkflowInstanceProgressInput {
  readonly instanceId: string;
  readonly expectedStatus: WorkflowInstanceStatus;
  readonly status: WorkflowInstanceStatus;
  readonly currentStepOrder: number;
  readonly completedAt: Date | null;
}

export interface WorkflowInstanceRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<WorkflowInstanceEntity | null>;
  findActiveByDocumentId(
    documentId: string,
    tx?: TransactionContext,
  ): Promise<WorkflowInstanceEntity | null>;
  findActiveByDocumentVersionId(
    documentVersionId: string,
    tx?: TransactionContext,
  ): Promise<WorkflowInstanceEntity | null>;
  listByDocumentId(
    documentId: string,
    tx?: TransactionContext,
  ): Promise<readonly WorkflowInstanceEntity[]>;
  create(
    input: CreateWorkflowInstanceRecordInput,
    tx?: TransactionContext,
  ): Promise<WorkflowInstanceEntity>;
  updateProgress(
    input: UpdateWorkflowInstanceProgressInput,
    tx?: TransactionContext,
  ): Promise<WorkflowInstanceEntity | null>;
}
