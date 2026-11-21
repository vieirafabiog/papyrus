import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { DocumentRepositoryPort } from "../ports/document-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import { assertDocumentStatusTransition } from "./document-state.js";
import type { DocumentEntity } from "./document.types.js";

export interface ArchiveDocumentServiceDependencies {
  readonly documents: DocumentRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
}

export interface ArchiveDocumentCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly reason?: string | null | undefined;
}

export interface ArchiveDocumentService {
  archiveDocument(command: ArchiveDocumentCommand): Promise<DocumentEntity>;
}

/**
 * Transitions an eligible document to ARCHIVED within a transaction,
 * enforcing optimistic concurrency control and emitting an audit event.
 */
export function archiveDocumentUseCase(
  deps: ArchiveDocumentServiceDependencies,
): ArchiveDocumentService {
  return {
    async archiveDocument(command: ArchiveDocumentCommand): Promise<DocumentEntity> {
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

        if (doc.status === "DELETED") {
          throw new DomainError(
            "INVALID_DOCUMENT_STATE",
            "Restaure o documento da lixeira antes de arquivá-lo.",
          );
        }

        assertDocumentStatusTransition(doc.status, "ARCHIVED");

        const updated = await deps.documents.updateStatus(
          doc.id,
          "ARCHIVED",
          command.expectedVersion,
          tx,
        );
        if (!updated) {
          throw new DomainError(
            "DOCUMENT_VERSION_CONFLICT",
            "O documento foi atualizado simultaneamente por outro usuário.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "DOCUMENT_ARCHIVED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              previousStatus: doc.status,
              ...(normalizedReason ? { reason: normalizedReason } : {}),
            },
          },
          tx,
        );

        return updated;
      });
    },
  };
}
