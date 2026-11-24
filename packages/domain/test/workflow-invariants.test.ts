import { describe, expect, it } from "vitest";
import {
  type DocumentEntity,
  DomainError,
  type WorkflowInstanceEntity,
  type WorkflowInstanceStatus,
  type WorkflowTaskEntity,
  type WorkflowTaskStatus,
  assertApprovalMatchesVersion,
  isTerminalInstanceStatus,
  isTerminalTaskStatus,
} from "../src/index.js";

const DOC_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "550e8400-e29b-41d4-a716-446655440003";

const DOC: DocumentEntity = {
  id: DOC_ID,
  organizationId: "550e8400-e29b-41d4-a716-446655440001",
  title: "Contrato",
  categoryId: "550e8400-e29b-41d4-a716-446655440002",
  folderId: null,
  status: "IN_REVIEW",
  currentVersionId: "v2",
  ownerUserId: USER_ID,
  issueDate: null,
  expirationDate: null,
  metadata: {},
  version: 2,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:05:00Z",
};

describe("Workflow domain invariants", () => {
  it("distinguishes terminal from non-terminal task and instance statuses", () => {
    expect(isTerminalTaskStatus("PENDING")).toBe(false);
    const terminalTaskStatuses: readonly WorkflowTaskStatus[] = [
      "APPROVED",
      "REJECTED",
      "CHANGES_REQUESTED",
      "CANCELLED",
      "EXPIRED",
    ];
    for (const status of terminalTaskStatuses) {
      expect(isTerminalTaskStatus(status)).toBe(true);
    }

    expect(isTerminalInstanceStatus("ACTIVE")).toBe(false);
    const terminalInstanceStatuses: readonly WorkflowInstanceStatus[] = [
      "COMPLETED",
      "REJECTED",
      "CHANGES_REQUESTED",
      "CANCELLED",
      "EXPIRED",
    ];
    for (const status of terminalInstanceStatuses) {
      expect(isTerminalInstanceStatus(status)).toBe(true);
    }
  });

  it("prevents duplicate decisions on tasks already in a terminal state", () => {
    const decidedTask: WorkflowTaskEntity = {
      id: "task-1",
      workflowInstanceId: "wf-1",
      documentId: DOC_ID,
      documentVersionId: "v1",
      stepOrder: 1,
      status: "APPROVED",
      assignee: { type: "USER", userId: USER_ID },
      dueAt: null,
      createdAt: "2026-11-20T10:00:00Z",
      decidedAt: "2026-11-20T10:02:00Z",
    };

    expect(isTerminalTaskStatus(decidedTask.status)).toBe(true);
  });

  it("prevents a workflow instance from approving a newer document version silently", () => {
    const instanceForV1: WorkflowInstanceEntity = {
      id: "wf-1",
      documentId: DOC_ID,
      documentVersionId: "v1",
      workflowDefinitionVersionId: "def-1",
      status: "ACTIVE",
      currentStepOrder: 1,
      startedByUserId: USER_ID,
      startedAt: "2026-11-20T10:00:00Z",
      completedAt: null,
    };

    expect(() => assertApprovalMatchesVersion(instanceForV1, DOC, "v2")).toThrowError(DomainError);
    expect(() => assertApprovalMatchesVersion(instanceForV1, DOC, "v1")).not.toThrow();
  });
});
