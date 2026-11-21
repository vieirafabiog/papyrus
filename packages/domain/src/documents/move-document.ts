import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { DocumentRepositoryPort } from "../ports/document-repository.port.js";
import type { FolderRepositoryPort } from "../ports/folder-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import type { DocumentEntity } from "./document.types.js";

export interface MoveDocumentServiceDependencies {
  readonly documents: DocumentRepositoryPort;
  readonly folders: FolderRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
}

export interface MoveDocumentCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly targetFolderId: string | null;
}

export interface MoveDocumentService {
  moveDocument(command: MoveDocumentCommand): Promise<DocumentEntity>;
}

/**
 * Moves a document to another active folder (or organization root) within a transaction,
 * enforcing optimistic concurrency control and emitting an audit event.
 */
export function moveDocumentUseCase(deps: MoveDocumentServiceDependencies): MoveDocumentService {
  return {
    async moveDocument(command: MoveDocumentCommand): Promise<DocumentEntity> {
      return deps.transactions.runInTransaction(async (tx) => {
        const doc = await deps.documents.findById(command.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }

        if (doc.status === "DELETED") {
          throw new DomainError(
            "INVALID_DOCUMENT_STATE",
            "Não é possível mover um documento que está na lixeira.",
          );
        }

        if (doc.version !== command.expectedVersion) {
          throw new DomainError(
            "DOCUMENT_VERSION_CONFLICT",
            "O documento foi atualizado simultaneamente por outro usuário.",
          );
        }

        if (command.targetFolderId !== null) {
          const targetFolder = await deps.folders.findById(command.targetFolderId, tx);
          if (!targetFolder || targetFolder.organizationId !== command.organizationId) {
            throw new DomainError("FOLDER_NOT_FOUND", "Pasta de destino não encontrada.");
          }
          if (targetFolder.status !== "ACTIVE") {
            throw new DomainError(
              "FOLDER_ARCHIVED",
              "Não é possível mover documentos para uma pasta arquivada.",
            );
          }
        }

        if (doc.folderId === command.targetFolderId) {
          return doc;
        }

        const updated = await deps.documents.updateWithOptimisticLock(
          doc.id,
          command.expectedVersion,
          { folderId: command.targetFolderId },
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
            action: "DOCUMENT_MOVED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              fromFolderId: doc.folderId,
              toFolderId: command.targetFolderId,
            },
          },
          tx,
        );

        return updated;
      });
    },
  };
}
