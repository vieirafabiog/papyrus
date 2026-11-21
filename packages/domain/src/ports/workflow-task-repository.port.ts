import type {
  WorkflowAssigneeTarget,
  WorkflowDecisionEntity,
  WorkflowDecisionType,
  WorkflowTaskEntity,
  WorkflowTaskStatus,
} from "../workflows/workflow.types.js";
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

export interface TransitionWorkflowTaskFromPendingInput {
  readonly taskId: string;
  readonly expectedStatus: "PENDING";
  readonly nextStatus: WorkflowTaskStatus;
  readonly decidedAt: Date;
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
  transitionFromPending(
    input: TransitionWorkflowTaskFromPendingInput,
    tx?: TransactionContext,
  ): Promise<WorkflowTaskEntity | null>;
  cancelPendingByInstanceId(
    workflowInstanceId: string,
    cancelledAt: Date,
    tx?: TransactionContext,
  ): Promise<number>;
}

export interface CreateWorkflowDecisionRecordInput {
  readonly id: string;
  readonly organizationId: string;
  readonly taskId: string;
  readonly actorUserId: string;
  readonly decision: WorkflowDecisionType;
  readonly comment: string | null;
  readonly idempotencyKey?: string | null | undefined;
  readonly createdAt: Date;
}

export interface WorkflowDecisionRepositoryPort {
  findByTaskId(taskId: string, tx?: TransactionContext): Promise<WorkflowDecisionEntity | null>;
  create(
    input: CreateWorkflowDecisionRecordInput,
    tx?: TransactionContext,
  ): Promise<WorkflowDecisionEntity>;
}
