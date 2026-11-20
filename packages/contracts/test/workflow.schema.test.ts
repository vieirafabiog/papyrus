import { describe, expect, it } from "vitest";
import {
  submitTaskDecisionInputSchema,
  workflowInstanceSchema,
  workflowTaskSchema,
} from "../src/index.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("Workflow and task contracts schemas", () => {
  it("requires a comment when rejecting or requesting changes", () => {
    expect(submitTaskDecisionInputSchema.safeParse({ decision: "APPROVE" }).success).toBe(true);
    expect(submitTaskDecisionInputSchema.safeParse({ decision: "REJECT" }).success).toBe(false);
    expect(
      submitTaskDecisionInputSchema.safeParse({
        decision: "REQUEST_CHANGES",
        comment: "   ",
      }).success,
    ).toBe(false);
    expect(
      submitTaskDecisionInputSchema.safeParse({
        decision: "REJECT",
        comment: "Documento sem assinatura.",
      }).success,
    ).toBe(true);
  });

  it("validates workflow instance and task bound to an exact document version", () => {
    expect(
      workflowInstanceSchema.safeParse({
        id: VALID_UUID,
        documentId: VALID_UUID,
        documentVersionId: VALID_UUID,
        workflowDefinitionVersionId: VALID_UUID,
        status: "ACTIVE",
        currentStepOrder: 1,
        startedByUserId: VALID_UUID,
        startedAt: "2026-11-20T10:00:00Z",
        completedAt: null,
      }).success,
    ).toBe(true);

    expect(
      workflowTaskSchema.safeParse({
        id: VALID_UUID,
        workflowInstanceId: VALID_UUID,
        documentId: VALID_UUID,
        documentVersionId: VALID_UUID,
        stepOrder: 1,
        status: "PENDING",
        assignee: { type: "ROLE", roleId: VALID_UUID },
        dueAt: null,
        createdAt: "2026-11-20T10:00:00Z",
        decidedAt: null,
      }).success,
    ).toBe(true);
  });
});
