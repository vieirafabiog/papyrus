import { z } from "zod";
import {
  createApiResponseSchema,
  createPaginatedResponseSchema,
  createSortSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema.js";
import { documentStatusSchema } from "./document.schema.js";

export const workflowTaskStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "CANCELLED",
  "EXPIRED",
]);
export type WorkflowTaskStatus = z.infer<typeof workflowTaskStatusSchema>;

export const workflowInstanceStatusSchema = z.enum([
  "ACTIVE",
  "COMPLETED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "CANCELLED",
  "EXPIRED",
]);
export type WorkflowInstanceStatus = z.infer<typeof workflowInstanceStatusSchema>;

export const workflowDecisionTypeSchema = z.enum(["APPROVE", "REJECT", "REQUEST_CHANGES"]);
export type WorkflowDecisionType = z.infer<typeof workflowDecisionTypeSchema>;

export const workflowAssigneeTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("USER"), userId: uuidSchema }),
  z.object({ type: z.literal("GROUP"), groupId: uuidSchema }),
  z.object({ type: z.literal("ROLE"), roleId: uuidSchema }),
]);
export type WorkflowAssigneeTarget = z.infer<typeof workflowAssigneeTargetSchema>;

export const workflowStepDefinitionSchema = z.object({
  stepOrder: z.number().int().min(1),
  name: z.string().trim().min(1).max(120),
  assignee: workflowAssigneeTargetSchema,
  dueDays: z.number().int().min(1).max(365).nullable(),
});
export type WorkflowStepDefinition = z.infer<typeof workflowStepDefinitionSchema>;

export const workflowDefinitionVersionSchema = z.object({
  id: uuidSchema,
  workflowDefinitionId: uuidSchema,
  versionNumber: z.number().int().min(1),
  steps: z.array(workflowStepDefinitionSchema).min(1),
  createdAt: isoDateTimeSchema,
});
export type WorkflowDefinitionVersionRecord = z.infer<typeof workflowDefinitionVersionSchema>;

export const workflowInstanceSchema = z.object({
  id: uuidSchema,
  documentId: uuidSchema,
  documentVersionId: uuidSchema,
  workflowDefinitionVersionId: uuidSchema,
  status: workflowInstanceStatusSchema,
  currentStepOrder: z.number().int().min(1),
  startedByUserId: uuidSchema,
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
});
export type WorkflowInstanceRecord = z.infer<typeof workflowInstanceSchema>;

export const workflowTaskSchema = z.object({
  id: uuidSchema,
  workflowInstanceId: uuidSchema,
  documentId: uuidSchema,
  documentVersionId: uuidSchema,
  stepOrder: z.number().int().min(1),
  status: workflowTaskStatusSchema,
  assignee: workflowAssigneeTargetSchema,
  dueAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  decidedAt: isoDateTimeSchema.nullable(),
});
export type WorkflowTaskRecord = z.infer<typeof workflowTaskSchema>;

export const submitTaskDecisionInputSchema = z
  .object({
    decision: workflowDecisionTypeSchema,
    comment: z.string().trim().max(2000).nullable().optional(),
  })
  .superRefine((input, ctx) => {
    const requiresComment = input.decision === "REJECT" || input.decision === "REQUEST_CHANGES";
    const hasComment = typeof input.comment === "string" && input.comment.trim().length > 0;
    if (requiresComment && !hasComment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comment"],
        message: "Comentário é obrigatório ao rejeitar ou solicitar ajustes.",
      });
    }
  });
export type SubmitTaskDecisionInput = z.infer<typeof submitTaskDecisionInputSchema>;

export const workflowDecisionRecordSchema = z.object({
  id: uuidSchema,
  taskId: uuidSchema,
  actorUserId: uuidSchema,
  decision: workflowDecisionTypeSchema,
  comment: z.string().trim().max(2000).nullable(),
  createdAt: isoDateTimeSchema,
});
export type WorkflowDecisionRecord = z.infer<typeof workflowDecisionRecordSchema>;

export const workflowStepCommentRulesSchema = z.object({
  requireOnApprove: z.boolean(),
  requireOnReject: z.literal(true),
  requireOnRequestChanges: z.literal(true),
});
export type WorkflowStepCommentRulesContract = z.infer<typeof workflowStepCommentRulesSchema>;

export const taskInboxSortSchema = createSortSchema([
  "dueAt",
  "createdAt",
  "status",
  "stepOrder",
  "id",
]);

const taskQueryBooleanSchema = z.preprocess((value) => {
  if (value === "true" || value === true) {
    return true;
  }
  if (value === "false" || value === false) {
    return false;
  }
  return value;
}, z.boolean());

export const taskInboxQuerySchema = paginationQuerySchema.merge(taskInboxSortSchema).extend({
  status: workflowTaskStatusSchema.optional(),
  documentId: uuidSchema.optional(),
  assigneeType: z.enum(["USER", "GROUP", "ROLE"]).optional(),
  overdueOnly: taskQueryBooleanSchema.optional(),
});
export type TaskInboxQuery = z.infer<typeof taskInboxQuerySchema>;

export const taskInboxItemSchema = workflowTaskSchema.extend({
  stepName: z.string().min(1).max(120),
  documentTitle: z.string().min(1).max(255),
  documentStatus: documentStatusSchema,
  documentVersionNumber: z.number().int().min(1),
  workflowDefinitionName: z.string().min(1).max(120),
  isOverdue: z.boolean(),
  commentRules: workflowStepCommentRulesSchema,
});
export type TaskInboxItem = z.infer<typeof taskInboxItemSchema>;

export const taskInboxListResponseSchema = createApiResponseSchema(
  createPaginatedResponseSchema(taskInboxItemSchema),
);
export type TaskInboxListResponse = z.infer<typeof taskInboxListResponseSchema>;

export const taskDetailResponseSchema = createApiResponseSchema(taskInboxItemSchema);
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;

export const submitTaskDecisionResultSchema = z.object({
  task: workflowTaskSchema,
  decision: workflowDecisionRecordSchema.nullable(),
  instance: workflowInstanceSchema,
  documentStatus: documentStatusSchema,
  idempotentReplay: z.boolean(),
});
export type SubmitTaskDecisionResult = z.infer<typeof submitTaskDecisionResultSchema>;

export const submitTaskDecisionResponseSchema = createApiResponseSchema(
  submitTaskDecisionResultSchema,
);
export type SubmitTaskDecisionResponse = z.infer<typeof submitTaskDecisionResponseSchema>;

export const workflowTimelineDecisionSchema = z.object({
  id: uuidSchema,
  decision: workflowDecisionTypeSchema,
  actorDisplayName: z.string().trim().min(1).max(160),
  comment: z.string().trim().max(2000).nullable(),
  createdAt: isoDateTimeSchema,
});
export type WorkflowTimelineDecision = z.infer<typeof workflowTimelineDecisionSchema>;

export const workflowTimelineStepSchema = z.object({
  stepOrder: z.number().int().min(1),
  stepName: z.string().trim().min(1).max(120),
  assigneeType: z.enum(["USER", "GROUP", "ROLE"]),
  assigneeDisplayName: z.string().trim().min(1).max(160),
  taskId: uuidSchema.nullable(),
  taskStatus: workflowTaskStatusSchema.nullable(),
  createdAt: isoDateTimeSchema.nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  decision: workflowTimelineDecisionSchema.nullable(),
});
export type WorkflowTimelineStep = z.infer<typeof workflowTimelineStepSchema>;

export const documentWorkflowTimelineInstanceSchema = z.object({
  id: uuidSchema,
  documentId: uuidSchema,
  documentVersionId: uuidSchema,
  documentVersionNumber: z.number().int().min(1),
  workflowDefinitionId: uuidSchema,
  workflowDefinitionName: z.string().trim().min(1).max(120),
  workflowDefinitionVersionNumber: z.number().int().min(1),
  status: workflowInstanceStatusSchema,
  currentStepOrder: z.number().int().min(1),
  startedByDisplayName: z.string().trim().min(1).max(160),
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  steps: z.array(workflowTimelineStepSchema).min(1),
});
export type DocumentWorkflowTimelineInstance = z.infer<
  typeof documentWorkflowTimelineInstanceSchema
>;

export const documentWorkflowTimelineResponseSchema = createApiResponseSchema(
  z.array(documentWorkflowTimelineInstanceSchema),
);
export type DocumentWorkflowTimelineResponse = z.infer<
  typeof documentWorkflowTimelineResponseSchema
>;

export const workflowDefinitionSummarySchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().nullable(),
  isActive: z.boolean(),
  latestVersionNumber: z.number().int().min(0),
});
export type WorkflowDefinitionSummary = z.infer<typeof workflowDefinitionSummarySchema>;

export const workflowDefinitionListResponseSchema = createApiResponseSchema(
  z.array(workflowDefinitionSummarySchema),
);
export type WorkflowDefinitionListResponse = z.infer<typeof workflowDefinitionListResponseSchema>;

export const startDocumentWorkflowRequestSchema = z.object({
  workflowDefinitionId: uuidSchema,
  documentVersionId: uuidSchema.optional(),
  expectedDocumentVersion: z.number().int().min(1).optional(),
});
export type StartDocumentWorkflowRequest = z.infer<typeof startDocumentWorkflowRequestSchema>;

export const startDocumentWorkflowResultSchema = z.object({
  instance: workflowInstanceSchema,
  task: workflowTaskSchema,
  documentStatus: documentStatusSchema,
});
export type StartDocumentWorkflowResult = z.infer<typeof startDocumentWorkflowResultSchema>;

export const startDocumentWorkflowResponseSchema = createApiResponseSchema(
  startDocumentWorkflowResultSchema,
);
export type StartDocumentWorkflowResponse = z.infer<typeof startDocumentWorkflowResponseSchema>;
