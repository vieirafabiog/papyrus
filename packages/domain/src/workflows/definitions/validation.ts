import { DomainError } from "../../index.js";
import type {
  WorkflowAssigneeTarget,
  WorkflowDecisionType,
  WorkflowStepCommentRules,
  WorkflowStepDefinition,
} from "../workflow.types.js";

export const MAX_WORKFLOW_DEFINITION_NAME_LENGTH = 120;
export const MAX_WORKFLOW_DEFINITION_DESCRIPTION_LENGTH = 500;
export const MAX_WORKFLOW_STEP_NAME_LENGTH = 120;
export const MAX_WORKFLOW_STEPS = 20;
export const MAX_WORKFLOW_STEP_DUE_DAYS = 365;
export const MAX_WORKFLOW_DECISION_COMMENT_LENGTH = 2000;

export interface WorkflowStepCommentRulesInput {
  readonly requireOnApprove?: boolean | undefined;
  readonly requireOnReject?: boolean | undefined;
  readonly requireOnRequestChanges?: boolean | undefined;
}

export interface WorkflowStepDefinitionInput {
  readonly stepOrder: number;
  readonly name: string;
  readonly assignee: WorkflowAssigneeTarget;
  readonly dueDays: number | null;
  readonly commentRules?: WorkflowStepCommentRulesInput | undefined;
}

export function normalizeWorkflowDefinitionName(rawName: string): string {
  const normalized = rawName.trim();
  if (normalized.length === 0) {
    throw new DomainError(
      "INVALID_WORKFLOW_DEFINITION_NAME",
      "O nome da definição de fluxo é obrigatório.",
    );
  }
  if (normalized.length > MAX_WORKFLOW_DEFINITION_NAME_LENGTH) {
    throw new DomainError(
      "INVALID_WORKFLOW_DEFINITION_NAME",
      `O nome da definição de fluxo deve ter no máximo ${MAX_WORKFLOW_DEFINITION_NAME_LENGTH} caracteres.`,
    );
  }
  return normalized;
}

export function normalizeWorkflowDefinitionDescription(
  rawDescription: string | null | undefined,
): string | null {
  if (rawDescription === undefined || rawDescription === null) {
    return null;
  }
  const normalized = rawDescription.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > MAX_WORKFLOW_DEFINITION_DESCRIPTION_LENGTH) {
    throw new DomainError(
      "INVALID_WORKFLOW_DEFINITION_DESCRIPTION",
      `A descrição do fluxo deve ter no máximo ${MAX_WORKFLOW_DEFINITION_DESCRIPTION_LENGTH} caracteres.`,
    );
  }
  return normalized;
}

export function normalizeWorkflowStepName(rawName: string, stepOrder: number): string {
  const normalized = rawName.trim();
  if (normalized.length === 0) {
    throw new DomainError("INVALID_WORKFLOW_STEP", `O nome da etapa ${stepOrder} é obrigatório.`);
  }
  if (normalized.length > MAX_WORKFLOW_STEP_NAME_LENGTH) {
    throw new DomainError(
      "INVALID_WORKFLOW_STEP",
      `O nome da etapa ${stepOrder} deve ter no máximo ${MAX_WORKFLOW_STEP_NAME_LENGTH} caracteres.`,
    );
  }
  return normalized;
}

export function cloneAndValidateWorkflowAssignee(
  assignee: WorkflowAssigneeTarget,
  stepOrder: number,
): WorkflowAssigneeTarget {
  switch (assignee.type) {
    case "USER": {
      const userId = assignee.userId.trim();
      if (userId.length === 0) {
        throw new DomainError(
          "INVALID_WORKFLOW_ASSIGNEE",
          `A etapa ${stepOrder} exige um identificador de usuário válido.`,
        );
      }
      return { type: "USER", userId };
    }
    case "GROUP": {
      const groupId = assignee.groupId.trim();
      if (groupId.length === 0) {
        throw new DomainError(
          "INVALID_WORKFLOW_ASSIGNEE",
          `A etapa ${stepOrder} exige um identificador de grupo válido.`,
        );
      }
      return { type: "GROUP", groupId };
    }
    case "ROLE": {
      const roleId = assignee.roleId.trim();
      if (roleId.length === 0) {
        throw new DomainError(
          "INVALID_WORKFLOW_ASSIGNEE",
          `A etapa ${stepOrder} exige um identificador de papel válido.`,
        );
      }
      return { type: "ROLE", roleId };
    }
  }
}

export function resolveStepCommentRules(
  input?: WorkflowStepCommentRulesInput,
): WorkflowStepCommentRules {
  if (input?.requireOnReject === false || input?.requireOnRequestChanges === false) {
    throw new DomainError(
      "INVALID_COMMENT_POLICY",
      "Comentário obrigatório não pode ser desabilitado para rejeição ou solicitação de ajustes.",
    );
  }

  return {
    requireOnApprove: input?.requireOnApprove ?? false,
    requireOnReject: true,
    requireOnRequestChanges: true,
  };
}

/**
 * Validates and clones a sequential list of workflow steps (`stepOrder` strictly
 * contiguous starting at 1), validating approvers, deadlines (`dueDays`), and
 * mandatory comment rules.
 */
export function validateSequentialWorkflowSteps(
  rawSteps: readonly WorkflowStepDefinitionInput[],
): readonly WorkflowStepDefinition[] {
  if (rawSteps.length === 0) {
    throw new DomainError(
      "INVALID_WORKFLOW_STEPS",
      "A definição de fluxo deve conter pelo menos uma etapa sequencial.",
    );
  }
  if (rawSteps.length > MAX_WORKFLOW_STEPS) {
    throw new DomainError(
      "INVALID_WORKFLOW_STEPS",
      `A definição de fluxo pode conter no máximo ${MAX_WORKFLOW_STEPS} etapas.`,
    );
  }

  const sorted = [...rawSteps].sort((a, b) => a.stepOrder - b.stepOrder);
  const validated: WorkflowStepDefinition[] = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const expectedOrder = index + 1;
    const step = sorted[index];
    if (!step) {
      continue;
    }

    if (!Number.isInteger(step.stepOrder) || step.stepOrder !== expectedOrder) {
      throw new DomainError(
        "INVALID_WORKFLOW_STEPS",
        `As etapas do fluxo devem ser estritamente sequenciais (esperada etapa ${expectedOrder}).`,
      );
    }

    if (
      step.dueDays !== null &&
      (!Number.isInteger(step.dueDays) ||
        step.dueDays < 1 ||
        step.dueDays > MAX_WORKFLOW_STEP_DUE_DAYS)
    ) {
      throw new DomainError(
        "INVALID_WORKFLOW_STEP_DUE_DAYS",
        `O prazo da etapa ${expectedOrder} deve ser entre 1 e ${MAX_WORKFLOW_STEP_DUE_DAYS} dias ou nulo.`,
      );
    }

    validated.push({
      stepOrder: expectedOrder,
      name: normalizeWorkflowStepName(step.name, expectedOrder),
      assignee: cloneAndValidateWorkflowAssignee(step.assignee, expectedOrder),
      dueDays: step.dueDays,
      commentRules: resolveStepCommentRules(step.commentRules),
    });
  }

  return validated;
}

export function requiresCommentForDecision(
  step: WorkflowStepDefinition,
  decision: WorkflowDecisionType,
): boolean {
  const rules = resolveStepCommentRules(step.commentRules);
  switch (decision) {
    case "APPROVE":
      return rules.requireOnApprove;
    case "REJECT":
      return rules.requireOnReject;
    case "REQUEST_CHANGES":
      return rules.requireOnRequestChanges;
  }
}

export function validateDecisionComment(
  step: WorkflowStepDefinition,
  decision: WorkflowDecisionType,
  rawComment: string | null | undefined,
): string | null {
  const normalized = rawComment === undefined || rawComment === null ? "" : rawComment.trim();

  if (normalized.length > MAX_WORKFLOW_DECISION_COMMENT_LENGTH) {
    throw new DomainError(
      "INVALID_DECISION_COMMENT",
      `O comentário da decisão deve ter no máximo ${MAX_WORKFLOW_DECISION_COMMENT_LENGTH} caracteres.`,
    );
  }

  if (requiresCommentForDecision(step, decision) && normalized.length === 0) {
    throw new DomainError(
      "COMMENT_REQUIRED",
      decision === "APPROVE"
        ? "Esta etapa exige comentário obrigatório para aprovação."
        : "Comentário é obrigatório ao rejeitar ou solicitar ajustes.",
    );
  }

  return normalized.length > 0 ? normalized : null;
}

export function calculateStepDueAt(startedAt: Date, dueDays: number | null): string | null {
  if (dueDays === null) {
    return null;
  }
  if (!Number.isInteger(dueDays) || dueDays < 1 || dueDays > MAX_WORKFLOW_STEP_DUE_DAYS) {
    throw new DomainError(
      "INVALID_WORKFLOW_STEP_DUE_DAYS",
      `O prazo da etapa deve ser entre 1 e ${MAX_WORKFLOW_STEP_DUE_DAYS} dias.`,
    );
  }
  const dueDate = new Date(startedAt.getTime() + dueDays * 24 * 60 * 60 * 1000);
  return dueDate.toISOString();
}
