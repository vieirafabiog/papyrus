import { createAuditWriter } from "../audit/audit-writer.js";
import type { DocumentEntity } from "../documents/document.types.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { CategoryRepositoryPort } from "../ports/category-repository.port.js";
import type { DocumentRepositoryPort } from "../ports/document-repository.port.js";
import type {
  DocumentRetentionHoldRepositoryPort,
  RetentionPolicyRepositoryPort,
} from "../ports/retention-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import type {
  DocumentRetentionHoldEntity,
  PurgeBlockReason,
  PurgeEligibilityEvaluation,
  RetentionAction,
  RetentionPolicyEntity,
} from "./retention.types.js";

export const MAX_RETENTION_POLICY_NAME_LENGTH = 120;
export const MAX_RETENTION_DAYS = 36_500;
export const MAX_TRASH_GRACE_DAYS = 3_650;
export const DEFAULT_TRASH_GRACE_DAYS = 30;
export const MAX_HOLD_REASON_LENGTH = 500;

const MS_PER_DAY = 86_400_000;

export interface RetentionGovernanceDependencies {
  readonly policies: RetentionPolicyRepositoryPort;
  readonly holds: DocumentRetentionHoldRepositoryPort;
  readonly documents: Pick<DocumentRepositoryPort, "findById">;
  readonly categories: Pick<CategoryRepositoryPort, "findById">;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
  readonly now?: (() => Date) | undefined;
}

export interface CreateRetentionPolicyCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly name: string;
  readonly categoryId?: string | null | undefined;
  readonly retentionDays: number;
  readonly trashGraceDays?: number | undefined;
  readonly actionOnExpiry?: RetentionAction | undefined;
  readonly isActive?: boolean | undefined;
}

export interface UpdateRetentionPolicyCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly policyId: string;
  readonly name?: string | undefined;
  readonly categoryId?: string | null | undefined;
  readonly retentionDays?: number | undefined;
  readonly trashGraceDays?: number | undefined;
  readonly actionOnExpiry?: RetentionAction | undefined;
  readonly isActive?: boolean | undefined;
}

export interface PlaceDocumentHoldCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly documentId: string;
  readonly reason: string;
}

export interface ReleaseDocumentHoldCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly documentId: string;
  readonly holdId: string;
  readonly releaseReason: string;
}

export interface EvaluatePurgeInput {
  readonly document: DocumentEntity | null;
  readonly deletedAt: Date | null;
  readonly activeHolds: readonly DocumentRetentionHoldEntity[];
  readonly policy: RetentionPolicyEntity | null;
  readonly referenceNow: Date;
  readonly fallbackTrashGraceDays?: number | undefined;
}

export interface CheckDocumentPurgeInput {
  readonly organizationId: string;
  readonly documentId: string;
  readonly deletedAt?: Date | null | undefined;
  readonly referenceNow?: Date | undefined;
  readonly fallbackTrashGraceDays?: number | undefined;
  readonly tx?: TransactionContext | undefined;
}

export interface RetentionGovernanceService {
  listPolicies(organizationId: string): Promise<readonly RetentionPolicyEntity[]>;
  createPolicy(command: CreateRetentionPolicyCommand): Promise<RetentionPolicyEntity>;
  updatePolicy(command: UpdateRetentionPolicyCommand): Promise<RetentionPolicyEntity>;
  listDocumentHolds(
    organizationId: string,
    documentId: string,
  ): Promise<readonly DocumentRetentionHoldEntity[]>;
  placeHold(command: PlaceDocumentHoldCommand): Promise<DocumentRetentionHoldEntity>;
  releaseHold(command: ReleaseDocumentHoldCommand): Promise<DocumentRetentionHoldEntity>;
  evaluatePurgeForDocument(input: CheckDocumentPurgeInput): Promise<PurgeEligibilityEvaluation>;
  assertPurgeAllowed(input: CheckDocumentPurgeInput): Promise<PurgeEligibilityEvaluation>;
}

function normalizePolicyName(rawName: string): string {
  const normalized = rawName.trim();
  if (normalized.length === 0) {
    throw new DomainError(
      "INVALID_RETENTION_POLICY_NAME",
      "O nome da política de retenção é obrigatório.",
    );
  }
  if (normalized.length > MAX_RETENTION_POLICY_NAME_LENGTH) {
    throw new DomainError(
      "INVALID_RETENTION_POLICY_NAME",
      `O nome da política de retenção deve ter no máximo ${MAX_RETENTION_POLICY_NAME_LENGTH} caracteres.`,
    );
  }
  return normalized;
}

function validatePositiveDays(value: number, fieldLabel: string, maxDays: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maxDays) {
    throw new DomainError(
      "INVALID_RETENTION_DAYS",
      `${fieldLabel} deve ser um número inteiro entre 1 e ${maxDays} dias.`,
    );
  }
  return value;
}

function normalizeHoldText(rawText: string, code: string, messagePrefix: string): string {
  const normalized = rawText.trim();
  if (normalized.length === 0) {
    throw new DomainError(code, `${messagePrefix} é obrigatória.`);
  }
  if (normalized.length > MAX_HOLD_REASON_LENGTH) {
    throw new DomainError(
      code,
      `${messagePrefix} deve ter no máximo ${MAX_HOLD_REASON_LENGTH} caracteres.`,
    );
  }
  return normalized;
}

/**
 * Selects the most specific active retention policy for a document's category,
 * falling back to the organization's active global policy when present.
 * Note: papyrus never supplies pre-populated universal legal timeframes.
 */
export function selectApplicableRetentionPolicy(
  policies: readonly RetentionPolicyEntity[],
  categoryId: string,
): RetentionPolicyEntity | null {
  let globalFallback: RetentionPolicyEntity | null = null;
  for (const policy of policies) {
    if (!policy.isActive) {
      continue;
    }
    if (policy.categoryId === categoryId) {
      return policy;
    }
    if (policy.categoryId === null && globalFallback === null) {
      globalFallback = policy;
    }
  }
  return globalFallback;
}

/**
 * Evaluates whether a deleted document is eligible for physical purge, enforcing
 * active legal hold blocks and configured trash-grace and retention windows.
 */
export function evaluateDocumentPurgeEligibility(
  input: EvaluatePurgeInput,
): PurgeEligibilityEvaluation {
  const activeHoldCount = input.activeHolds.filter((hold) => hold.releasedAt === null).length;

  if (!input.document) {
    return {
      eligible: false,
      blockReasons: ["DOCUMENT_NOT_FOUND"],
      activeHoldCount,
      applicablePolicyId: input.policy?.id ?? null,
      trashGraceEndsAt: null,
      retentionEndsAt: null,
    };
  }

  const blockReasons: PurgeBlockReason[] = [];

  if (input.document.status !== "DELETED") {
    blockReasons.push("NOT_IN_TRASH");
  }

  if (activeHoldCount > 0) {
    blockReasons.push("ACTIVE_HOLD");
  }

  const graceDays =
    input.policy?.trashGraceDays ?? input.fallbackTrashGraceDays ?? DEFAULT_TRASH_GRACE_DAYS;
  const trashGraceEndsAtMs =
    input.deletedAt !== null ? input.deletedAt.getTime() + graceDays * MS_PER_DAY : null;

  if (
    input.document.status === "DELETED" &&
    (trashGraceEndsAtMs === null || input.referenceNow.getTime() < trashGraceEndsAtMs)
  ) {
    blockReasons.push("TRASH_GRACE_WINDOW_NOT_ELAPSED");
  }

  let retentionEndsAtMs: number | null = null;
  if (input.policy !== null) {
    const createdAtMs = Date.parse(input.document.createdAt);
    if (!Number.isNaN(createdAtMs)) {
      retentionEndsAtMs = createdAtMs + input.policy.retentionDays * MS_PER_DAY;
      if (input.referenceNow.getTime() < retentionEndsAtMs) {
        blockReasons.push("RETENTION_WINDOW_NOT_ELAPSED");
      }
    }
  }

  return {
    eligible: blockReasons.length === 0,
    blockReasons,
    activeHoldCount,
    applicablePolicyId: input.policy?.id ?? null,
    trashGraceEndsAt:
      trashGraceEndsAtMs !== null ? new Date(trashGraceEndsAtMs).toISOString() : null,
    retentionEndsAt: retentionEndsAtMs !== null ? new Date(retentionEndsAtMs).toISOString() : null,
  };
}

/**
 * Coordinates organization-configured retention rules and document legal holds
 * with transactional audit logging. No universal legal timeframes are pre-seeded.
 */
export function createRetentionGovernanceService(
  deps: RetentionGovernanceDependencies,
): RetentionGovernanceService {
  const nowFn = deps.now ?? (() => new Date());
  const auditWriter = createAuditWriter({ repository: deps.audit });

  const loadPurgeEvaluation = async (
    input: CheckDocumentPurgeInput,
    tx?: TransactionContext,
  ): Promise<PurgeEligibilityEvaluation> => {
    const doc = await deps.documents.findById(input.documentId, tx);
    if (!doc || doc.organizationId !== input.organizationId) {
      return evaluateDocumentPurgeEligibility({
        document: null,
        deletedAt: null,
        activeHolds: [],
        policy: null,
        referenceNow: input.referenceNow ?? nowFn(),
        fallbackTrashGraceDays: input.fallbackTrashGraceDays,
      });
    }

    const [activeHolds, policy, resolvedDeletedAt] = await Promise.all([
      deps.holds.listActiveForDocument(input.organizationId, doc.id, tx),
      deps.policies.findApplicablePolicy(input.organizationId, doc.categoryId, tx),
      input.deletedAt !== undefined
        ? Promise.resolve(input.deletedAt)
        : deps.holds.findDocumentDeletedAt
          ? deps.holds.findDocumentDeletedAt(input.organizationId, doc.id, tx)
          : Promise.resolve(null),
    ]);

    return evaluateDocumentPurgeEligibility({
      document: doc,
      deletedAt: resolvedDeletedAt,
      activeHolds,
      policy,
      referenceNow: input.referenceNow ?? nowFn(),
      fallbackTrashGraceDays: input.fallbackTrashGraceDays,
    });
  };

  return {
    listPolicies(organizationId: string): Promise<readonly RetentionPolicyEntity[]> {
      return deps.policies.listByOrganization(organizationId);
    },

    async createPolicy(command: CreateRetentionPolicyCommand): Promise<RetentionPolicyEntity> {
      const normalizedName = normalizePolicyName(command.name);
      const retentionDays = validatePositiveDays(
        command.retentionDays,
        "O prazo de retenção",
        MAX_RETENTION_DAYS,
      );
      const trashGraceDays = validatePositiveDays(
        command.trashGraceDays ?? DEFAULT_TRASH_GRACE_DAYS,
        "O prazo de tolerância da lixeira",
        MAX_TRASH_GRACE_DAYS,
      );
      const actionOnExpiry = command.actionOnExpiry ?? "TRASH";
      const isActive = command.isActive ?? true;
      const categoryId = command.categoryId ?? null;

      return deps.transactions.runInTransaction(async (tx) => {
        if (categoryId !== null) {
          const category = await deps.categories.findById(categoryId, tx);
          if (!category || category.organizationId !== command.organizationId) {
            throw new DomainError("CATEGORY_NOT_FOUND", "Categoria alvo não encontrada.");
          }
        }

        const existingByName = await deps.policies.findByName(
          command.organizationId,
          normalizedName,
          tx,
        );
        if (existingByName) {
          throw new DomainError(
            "RETENTION_POLICY_NAME_IN_USE",
            "Já existe uma política de retenção com este nome na organização.",
          );
        }

        const created = await deps.policies.create(
          {
            id: deps.generateId(),
            organizationId: command.organizationId,
            categoryId,
            name: normalizedName,
            retentionDays,
            trashGraceDays,
            actionOnExpiry,
            isActive,
            createdBy: command.actorUserId,
          },
          tx,
        );

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "RETENTION_POLICY_CREATED",
            resourceType: "RETENTION_POLICY",
            resourceId: created.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              categoryId: created.categoryId,
              retentionDays: created.retentionDays,
              trashGraceDays: created.trashGraceDays,
              actionOnExpiry: created.actionOnExpiry,
              isActive: created.isActive,
            },
          },
          tx,
        );

        return created;
      });
    },

    async updatePolicy(command: UpdateRetentionPolicyCommand): Promise<RetentionPolicyEntity> {
      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.policies.findById(command.policyId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError(
            "RETENTION_POLICY_NOT_FOUND",
            "Política de retenção não encontrada.",
          );
        }

        const normalizedName =
          command.name !== undefined ? normalizePolicyName(command.name) : undefined;
        if (normalizedName !== undefined && normalizedName !== existing.name) {
          const duplicate = await deps.policies.findByName(
            command.organizationId,
            normalizedName,
            tx,
          );
          if (duplicate && duplicate.id !== existing.id) {
            throw new DomainError(
              "RETENTION_POLICY_NAME_IN_USE",
              "Já existe uma política de retenção com este nome na organização.",
            );
          }
        }

        if (command.categoryId !== undefined && command.categoryId !== null) {
          const category = await deps.categories.findById(command.categoryId, tx);
          if (!category || category.organizationId !== command.organizationId) {
            throw new DomainError("CATEGORY_NOT_FOUND", "Categoria alvo não encontrada.");
          }
        }

        const retentionDays =
          command.retentionDays !== undefined
            ? validatePositiveDays(command.retentionDays, "O prazo de retenção", MAX_RETENTION_DAYS)
            : undefined;
        const trashGraceDays =
          command.trashGraceDays !== undefined
            ? validatePositiveDays(
                command.trashGraceDays,
                "O prazo de tolerância da lixeira",
                MAX_TRASH_GRACE_DAYS,
              )
            : undefined;

        const updated = await deps.policies.update(
          existing.id,
          {
            name: normalizedName,
            categoryId: command.categoryId,
            retentionDays,
            trashGraceDays,
            actionOnExpiry: command.actionOnExpiry,
            isActive: command.isActive,
            updatedBy: command.actorUserId,
          },
          tx,
        );

        if (!updated) {
          throw new DomainError(
            "RETENTION_POLICY_NOT_FOUND",
            "Política de retenção não encontrada.",
          );
        }

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "RETENTION_POLICY_UPDATED",
            resourceType: "RETENTION_POLICY",
            resourceId: updated.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              categoryId: updated.categoryId,
              retentionDays: updated.retentionDays,
              trashGraceDays: updated.trashGraceDays,
              actionOnExpiry: updated.actionOnExpiry,
              isActive: updated.isActive,
            },
          },
          tx,
        );

        return updated;
      });
    },

    listDocumentHolds(
      organizationId: string,
      documentId: string,
    ): Promise<readonly DocumentRetentionHoldEntity[]> {
      return deps.holds.listForDocument(organizationId, documentId);
    },

    async placeHold(command: PlaceDocumentHoldCommand): Promise<DocumentRetentionHoldEntity> {
      const reason = normalizeHoldText(
        command.reason,
        "INVALID_HOLD_REASON",
        "A justificativa do bloqueio (hold)",
      );
      const placedAt = nowFn();

      return deps.transactions.runInTransaction(async (tx) => {
        const doc = await deps.documents.findById(command.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }

        const hold = await deps.holds.createHold(
          {
            id: deps.generateId(),
            organizationId: command.organizationId,
            documentId: doc.id,
            reason,
            placedByUserId: command.actorUserId,
            placedAt,
          },
          tx,
        );

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "RETENTION_HOLD_PLACED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              holdId: hold.id,
            },
          },
          tx,
        );

        return hold;
      });
    },

    async releaseHold(command: ReleaseDocumentHoldCommand): Promise<DocumentRetentionHoldEntity> {
      const releaseReason = normalizeHoldText(
        command.releaseReason,
        "INVALID_HOLD_RELEASE_REASON",
        "A justificativa de liberação do bloqueio",
      );
      const releasedAt = nowFn();

      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.holds.findById(command.holdId, tx);
        if (
          !existing ||
          existing.organizationId !== command.organizationId ||
          existing.documentId !== command.documentId
        ) {
          throw new DomainError("HOLD_NOT_FOUND", "Bloqueio de retenção não encontrado.");
        }

        if (existing.releasedAt !== null) {
          throw new DomainError(
            "HOLD_ALREADY_RELEASED",
            "Este bloqueio de retenção já foi liberado.",
          );
        }

        const released = await deps.holds.releaseHold(
          {
            organizationId: command.organizationId,
            documentId: command.documentId,
            holdId: existing.id,
            releasedByUserId: command.actorUserId,
            releasedAt,
            releaseReason,
          },
          tx,
        );

        if (!released) {
          throw new DomainError(
            "HOLD_ALREADY_RELEASED",
            "Este bloqueio de retenção já foi liberado.",
          );
        }

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "RETENTION_HOLD_RELEASED",
            resourceType: "DOCUMENT",
            resourceId: command.documentId,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              holdId: released.id,
            },
          },
          tx,
        );

        return released;
      });
    },

    evaluatePurgeForDocument(input: CheckDocumentPurgeInput): Promise<PurgeEligibilityEvaluation> {
      return loadPurgeEvaluation(input, input.tx);
    },

    async assertPurgeAllowed(input: CheckDocumentPurgeInput): Promise<PurgeEligibilityEvaluation> {
      const evaluation = await loadPurgeEvaluation(input, input.tx);
      if (evaluation.blockReasons.includes("DOCUMENT_NOT_FOUND")) {
        throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
      }
      if (evaluation.blockReasons.includes("ACTIVE_HOLD")) {
        throw new DomainError(
          "RETENTION_HOLD_ACTIVE",
          "Expurgo bloqueado: existe bloqueio de retenção (hold) ativo neste documento.",
        );
      }
      if (!evaluation.eligible) {
        throw new DomainError(
          "PURGE_WINDOW_NOT_ELAPSED",
          "O documento ainda não cumpriu os critérios de estado ou janela de retenção para expurgo.",
        );
      }
      return evaluation;
    },
  };
}
