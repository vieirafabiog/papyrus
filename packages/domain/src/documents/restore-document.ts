import { createAuditWriter } from "../audit/audit-writer.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { DocumentRepositoryPort } from "../ports/document-repository.port.js";
import type {
  DocumentRetentionHoldRepositoryPort,
  RetentionPolicyRepositoryPort,
} from "../ports/retention-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import { DEFAULT_TRASH_GRACE_DAYS } from "../retention/retention-service.js";
import { assertDocumentStatusTransition } from "./document-state.js";
import type { DocumentEntity } from "./document.types.js";

const MS_PER_DAY = 86_400_000;

export type RestorableDocumentTargetStatus = "DRAFT" | "ARCHIVED";

export interface RestoreDocumentServiceDependencies {
  readonly documents: Pick<DocumentRepositoryPort, "findById" | "updateStatus">;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly policies?: Pick<RetentionPolicyRepositoryPort, "findApplicablePolicy"> | undefined;
  readonly holds?: Pick<DocumentRetentionHoldRepositoryPort, "findDocumentDeletedAt"> | undefined;
  readonly defaultTrashGraceDays?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface RestoreDocumentCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly targetStatus?: RestorableDocumentTargetStatus | undefined;
  readonly reason?: string | null | undefined;
}

export interface RestoreDocumentService {
  restoreDocument(command: RestoreDocumentCommand): Promise<DocumentEntity>;
}

/**
 * Computes the trash grace deadline and whether restoration is still allowed at `referenceNow`.
 */
export function evaluateTrashRestoreWindow(input: {
  readonly deletedAt: Date | null;
  readonly graceDays: number | null | undefined;
  readonly referenceNow: Date;
}): {
  readonly graceDays: number;
  readonly restoreDeadlineAt: Date | null;
  readonly canRestore: boolean;
} {
  const graceDays = input.graceDays ?? DEFAULT_TRASH_GRACE_DAYS;
  if (!input.deletedAt) {
    return {
      graceDays,
      restoreDeadlineAt: null,
      canRestore: graceDays > 0,
    };
  }

  const deadlineMs = input.deletedAt.getTime() + graceDays * MS_PER_DAY;
  return {
    graceDays,
    restoreDeadlineAt: new Date(deadlineMs),
    canRestore: input.referenceNow.getTime() < deadlineMs,
  };
}

/**
 * Restores a logically deleted document from the trash while within the allowed
 * grace window, keeping immutable document versions, workflows, and permissions intact.
 */
export function restoreDocumentUseCase(
  deps: RestoreDocumentServiceDependencies,
): RestoreDocumentService {
  const auditWriter = createAuditWriter({ repository: deps.audit });
  const now = deps.now ?? (() => new Date());

  return {
    async restoreDocument(command: RestoreDocumentCommand): Promise<DocumentEntity> {
      const targetStatus: RestorableDocumentTargetStatus = command.targetStatus ?? "DRAFT";
      const normalizedReason =
        command.reason && command.reason.trim().length > 0 ? command.reason.trim() : null;

      return deps.transactions.runInTransaction(async (tx) => {
        const doc = await deps.documents.findById(command.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }

        if (doc.version !== command.expectedVersion) {
          throw new DomainError(
            "DOCUMENT_VERSION_CONFLICT",
            "O documento foi atualizado simultaneamente por outro usuário.",
          );
        }

        if (doc.status !== "DELETED") {
          throw new DomainError(
            "INVALID_DOCUMENT_STATE",
            "Somente documentos na lixeira podem ser restaurados.",
          );
        }

        assertDocumentStatusTransition(doc.status, targetStatus);

        const referenceNow = now();
        const [deletedAt, applicablePolicy] = await Promise.all([
          deps.holds?.findDocumentDeletedAt
            ? deps.holds.findDocumentDeletedAt(command.organizationId, doc.id, tx)
            : Promise.resolve(null),
          deps.policies?.findApplicablePolicy
            ? deps.policies.findApplicablePolicy(command.organizationId, doc.categoryId, tx)
            : Promise.resolve(null),
        ]);

        const fallbackGraceDays = deps.defaultTrashGraceDays ?? DEFAULT_TRASH_GRACE_DAYS;
        const restoreWindow = evaluateTrashRestoreWindow({
          deletedAt,
          graceDays: applicablePolicy?.trashGraceDays ?? fallbackGraceDays,
          referenceNow,
        });

        if (!restoreWindow.canRestore) {
          throw new DomainError(
            "RESTORE_WINDOW_EXPIRED",
            "O prazo configurado na lixeira para restaurar este documento já expirou.",
          );
        }

        const restored = await deps.documents.updateStatus(
          doc.id,
          targetStatus,
          command.expectedVersion,
          tx,
        );
        if (!restored) {
          throw new DomainError(
            "DOCUMENT_VERSION_CONFLICT",
            "O documento foi atualizado simultaneamente por outro usuário.",
          );
        }

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "DOCUMENT_RESTORED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              previousStatus: doc.status,
              newStatus: restored.status,
              preservedVersionId: doc.currentVersionId,
              graceDays: restoreWindow.graceDays,
              ...(deletedAt ? { deletedAt: deletedAt.toISOString() } : {}),
              ...(normalizedReason ? { reason: normalizedReason } : {}),
            },
          },
          tx,
        );

        return restored;
      });
    },
  };
}
