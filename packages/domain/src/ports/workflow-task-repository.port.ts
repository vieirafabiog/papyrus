import type { WorkflowAssigneeTarget, WorkflowTaskEntity } from "../workflows/workflow.types.js";
import type { TransactionContext } from "./transaction.port.js";

export interface CreateWorkflowTaskIdempotentInput {
  readonly id: string;
  readonly organizationId: string;
  readonly workflowInstanceId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly stepOrder: number;
  readonly assignee: WorkflowAssigneeTarget;
  readonly dueAt: Date | null;
}

export interface CreateWorkflowTaskRecordResult {
  readonly task: WorkflowTaskEntity;
  readonly created: boolean;
}

export interface WorkflowTaskRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<WorkflowTaskEntity | null>;
  findByInstanceAndStep(
    workflowInstanceId: string,
    stepOrder: number,
    tx?: TransactionContext,
  ): Promise<WorkflowTaskEntity | null>;
  listByInstanceId(
    workflowInstanceId: string,
    tx?: TransactionContext,
  ): Promise<readonly WorkflowTaskEntity[]>;
  createIdempotent(
    input: CreateWorkflowTaskIdempotentInput,
    tx?: TransactionContext,
  ): Promise<CreateWorkflowTaskRecordResult>;
}
