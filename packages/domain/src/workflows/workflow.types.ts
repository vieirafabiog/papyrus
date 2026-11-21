export const WORKFLOW_TASK_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "CANCELLED",
  "EXPIRED",
] as const;

export type WorkflowTaskStatus = (typeof WORKFLOW_TASK_STATUSES)[number];

export const TERMINAL_WORKFLOW_TASK_STATUSES: ReadonlySet<WorkflowTaskStatus> = new Set([
  "APPROVED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "CANCELLED",
  "EXPIRED",
]);

export const WORKFLOW_INSTANCE_STATUSES = [
  "ACTIVE",
  "COMPLETED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "CANCELLED",
  "EXPIRED",
] as const;

export type WorkflowInstanceStatus = (typeof WORKFLOW_INSTANCE_STATUSES)[number];

export const TERMINAL_WORKFLOW_INSTANCE_STATUSES: ReadonlySet<WorkflowInstanceStatus> = new Set([
  "COMPLETED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "CANCELLED",
  "EXPIRED",
]);

export type WorkflowDecisionType = "APPROVE" | "REJECT" | "REQUEST_CHANGES";

export type WorkflowAssigneeTarget =
  | { readonly type: "USER"; readonly userId: string }
  | { readonly type: "GROUP"; readonly groupId: string }
  | { readonly type: "ROLE"; readonly roleId: string };

export interface WorkflowStepCommentRules {
  readonly requireOnApprove: boolean;
  readonly requireOnReject: true;
  readonly requireOnRequestChanges: true;
}

export interface WorkflowStepDefinition {
  readonly stepOrder: number;
  readonly name: string;
  readonly assignee: WorkflowAssigneeTarget;
  readonly dueDays: number | null;
  readonly commentRules?: WorkflowStepCommentRules | undefined;
}

export interface WorkflowDefinitionEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly latestVersionNumber: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowDefinitionVersionEntity {
  readonly id: string;
  readonly workflowDefinitionId: string;
  readonly versionNumber: number;
  readonly steps: readonly WorkflowStepDefinition[];
  readonly createdAt: string;
}

export interface WorkflowInstanceEntity {
  readonly id: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly workflowDefinitionVersionId: string;
  readonly status: WorkflowInstanceStatus;
  readonly currentStepOrder: number;
  readonly startedByUserId: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface WorkflowTaskEntity {
  readonly id: string;
  readonly workflowInstanceId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly stepOrder: number;
  readonly status: WorkflowTaskStatus;
  readonly assignee: WorkflowAssigneeTarget;
  readonly dueAt: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface WorkflowDecisionEntity {
  readonly id: string;
  readonly taskId: string;
  readonly actorUserId: string;
  readonly decision: WorkflowDecisionType;
  readonly comment: string | null;
  readonly createdAt: string;
}

export function isTerminalTaskStatus(status: WorkflowTaskStatus): boolean {
  return TERMINAL_WORKFLOW_TASK_STATUSES.has(status);
}

export function isTerminalInstanceStatus(status: WorkflowInstanceStatus): boolean {
  return TERMINAL_WORKFLOW_INSTANCE_STATUSES.has(status);
}
