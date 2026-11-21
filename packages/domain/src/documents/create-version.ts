import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type {
  DocumentRepositoryPort,
  DocumentVersionRepositoryPort,
} from "../ports/document-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import type { UploadSessionRepositoryPort } from "../ports/upload-session-repository.port.js";
import type { DocumentEntity, DocumentVersionEntity, FileObjectEntity } from "./document.types.js";
import { buildNextDocumentVersion, restoreHistoricalVersion } from "./versioning.js";

export interface CreateDocumentVersionServiceDependencies {
  readonly documents: DocumentRepositoryPort;
  readonly documentVersions: DocumentVersionRepositoryPort;
  readonly uploadSessions: UploadSessionRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
  readonly now?: (() => Date) | undefined;
}

export interface CreateNewDocumentVersionCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly fileObjectId?: string | undefined;
  readonly uploadSessionId?: string | undefined;
  readonly changeNote?: string | null | undefined;
}

export interface RestoreDocumentVersionCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly documentId: string;
  readonly targetVersionId: string;
  readonly expectedVersion: number;
  readonly changeNote?: string | null | undefined;
}

export interface CreatedDocumentVersionResult {
  readonly document: DocumentEntity;
  readonly version: DocumentVersionEntity;
  readonly fileObject: FileObjectEntity;
}

export interface CreateDocumentVersionService {
  createVersion(command: CreateNewDocumentVersionCommand): Promise<CreatedDocumentVersionResult>;
  restoreVersion(command: RestoreDocumentVersionCommand): Promise<CreatedDocumentVersionResult>;
}

/**
 * Creates an append-only document version linked to a newly available FileObject,
 * enforcing optimistic concurrency control to prevent duplicate version numbers.
 */
export function createDocumentVersionUseCase(
  deps: CreateDocumentVersionServiceDependencies,
): CreateDocumentVersionService {
  const now = deps.now ?? (() => new Date());

  return {
    async createVersion(
      command: CreateNewDocumentVersionCommand,
    ): Promise<CreatedDocumentVersionResult> {
      const normalizedNote =
        command.changeNote && command.changeNote.trim().length > 0
          ? command.changeNote.trim()
          : null;

      return deps.transactions.runInTransaction(async (tx) => {
        const doc = await deps.documents.findById(command.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }

        if (doc.status === "DELETED" || doc.status === "ARCHIVED") {
          throw new DomainError(
            "INVALID_DOCUMENT_STATE",
            "Não é possível criar nova versão para documento arquivado ou excluído.",
          );
        }

        if (doc.version !== command.expectedVersion) {
          throw new DomainError(
            "DOCUMENT_VERSION_CONFLICT",
            "O documento foi atualizado simultaneamente por outro usuário.",
          );
        }

        let targetFileObjectId = command.fileObjectId;
        if (command.uploadSessionId !== undefined) {
          const session = await deps.uploadSessions.findById(command.uploadSessionId, tx);
          if (!session || session.organizationId !== command.organizationId) {
            throw new DomainError("UPLOAD_SESSION_NOT_FOUND", "Sessão de upload não encontrada.");
          }
          if (session.userId !== command.actorUserId) {
            throw new DomainError(
              "UPLOAD_SESSION_FORBIDDEN",
              "A sessão de upload pertence a outro usuário.",
            );
          }
          if (session.status !== "FINALIZED") {
            throw new DomainError(
              "UPLOAD_NOT_FINALIZED",
              "A sessão de upload precisa estar finalizada antes de gerar nova versão.",
            );
          }
          if (command.fileObjectId !== undefined && command.fileObjectId !== session.fileObjectId) {
            throw new DomainError(
              "FILE_OBJECT_SESSION_MISMATCH",
              "O arquivo informado não corresponde à sessão de upload selecionada.",
            );
          }
          targetFileObjectId = session.fileObjectId;
        }

        if (!targetFileObjectId) {
          throw new DomainError(
            "INVALID_VERSION_INPUT",
            "Informe um fileObjectId disponível ou uma sessão de upload finalizada.",
          );
        }

        if (deps.uploadSessions.findFileObjectOrganizationId) {
          const ownerOrgId = await deps.uploadSessions.findFileObjectOrganizationId(
            targetFileObjectId,
            tx,
          );
          if (!ownerOrgId || ownerOrgId !== command.organizationId) {
            throw new DomainError("FILE_OBJECT_NOT_FOUND", "Arquivo não encontrado.");
          }
        }

        const fileObject = await deps.uploadSessions.findFileObjectById(targetFileObjectId, tx);
        if (!fileObject) {
          throw new DomainError("FILE_OBJECT_NOT_FOUND", "Arquivo não encontrado.");
        }

        if (fileObject.status !== "AVAILABLE") {
          throw new DomainError(
            "FILE_OBJECT_NOT_AVAILABLE",
            "Somente arquivos verificados e disponíveis podem originar uma nova versão.",
          );
        }

        const existingLink = await deps.documentVersions.findByFileObjectId(fileObject.id, tx);
        if (existingLink) {
          throw new DomainError(
            "FILE_ALREADY_LINKED_TO_DOCUMENT",
            "Este arquivo já está vinculado a uma versão documental existente.",
          );
        }

        const existingVersions = await deps.documentVersions.listByDocumentId(doc.id, tx);
        const nextVersionCandidate = buildNextDocumentVersion({
          id: deps.generateId(),
          documentId: doc.id,
          existingVersions,
          fileObjectId: fileObject.id,
          uploadedByUserId: command.actorUserId,
          changeNote: normalizedNote,
          createdAt: now().toISOString(),
        });

        const createdVersion = await deps.documentVersions.create(
          {
            id: nextVersionCandidate.id,
            documentId: nextVersionCandidate.documentId,
            versionNumber: nextVersionCandidate.versionNumber,
            fileObjectId: nextVersionCandidate.fileObjectId,
            uploadedByUserId: nextVersionCandidate.uploadedByUserId,
            changeNote: nextVersionCandidate.changeNote,
          },
          tx,
        );

        const updatedDocument = await deps.documents.setCurrentVersion(
          doc.id,
          createdVersion.id,
          command.expectedVersion,
          tx,
        );
        if (!updatedDocument) {
          throw new DomainError(
            "DOCUMENT_VERSION_CONFLICT",
            "Concorrência detectada ao atualizar a versão corrente do documento.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "DOCUMENT_VERSION_CREATED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              versionId: createdVersion.id,
              versionNumber: createdVersion.versionNumber,
              fileObjectId: fileObject.id,
              previousVersionId: doc.currentVersionId,
            },
          },
          tx,
        );

        return {
          document: updatedDocument,
          version: createdVersion,
          fileObject,
        };
      });
    },

    async restoreVersion(
      command: RestoreDocumentVersionCommand,
    ): Promise<CreatedDocumentVersionResult> {
      const normalizedNote =
        command.changeNote && command.changeNote.trim().length > 0
          ? command.changeNote.trim()
          : null;

      return deps.transactions.runInTransaction(async (tx) => {
        const doc = await deps.documents.findById(command.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }

        if (doc.status === "DELETED" || doc.status === "ARCHIVED") {
          throw new DomainError(
            "INVALID_DOCUMENT_STATE",
            "Não é possível restaurar versão para documento arquivado ou excluído.",
          );
        }

        if (doc.version !== command.expectedVersion) {
          throw new DomainError(
            "DOCUMENT_VERSION_CONFLICT",
            "O documento foi atualizado simultaneamente por outro usuário.",
          );
        }

        const existingVersions = await deps.documentVersions.listByDocumentId(doc.id, tx);
        const targetVersion = existingVersions.find(
          (version) => version.id === command.targetVersionId,
        );
        if (!targetVersion) {
          throw new DomainError(
            "VERSION_NOT_FOUND",
            "A versão histórica informada para restauração não foi encontrada.",
          );
        }

        if (doc.currentVersionId === targetVersion.id) {
          throw new DomainError(
            "VERSION_ALREADY_CURRENT",
            "A versão selecionada já é a versão vigente do documento.",
          );
        }

        if (deps.uploadSessions.findFileObjectOrganizationId) {
          const ownerOrgId = await deps.uploadSessions.findFileObjectOrganizationId(
            targetVersion.fileObjectId,
            tx,
          );
          if (!ownerOrgId || ownerOrgId !== command.organizationId) {
            throw new DomainError("FILE_OBJECT_NOT_FOUND", "Arquivo não encontrado.");
          }
        }

        const fileObject = await deps.uploadSessions.findFileObjectById(
          targetVersion.fileObjectId,
          tx,
        );
        if (!fileObject) {
          throw new DomainError("FILE_OBJECT_NOT_FOUND", "Arquivo não encontrado.");
        }

        if (fileObject.status !== "AVAILABLE") {
          throw new DomainError(
            "FILE_OBJECT_NOT_AVAILABLE",
            "Somente versões cujo arquivo permanece disponível podem ser restauradas.",
          );
        }

        const { restoredVersion, sourceVersion } = restoreHistoricalVersion({
          newVersionId: deps.generateId(),
          document: doc,
          existingVersions,
          targetVersionId: targetVersion.id,
          restoredByUserId: command.actorUserId,
          createdAt: now().toISOString(),
        });

        const createdVersion = await deps.documentVersions.create(
          {
            id: restoredVersion.id,
            documentId: restoredVersion.documentId,
            versionNumber: restoredVersion.versionNumber,
            fileObjectId: restoredVersion.fileObjectId,
            uploadedByUserId: restoredVersion.uploadedByUserId,
            changeNote: normalizedNote ?? restoredVersion.changeNote,
          },
          tx,
        );

        const updatedDocument = await deps.documents.setCurrentVersion(
          doc.id,
          createdVersion.id,
          command.expectedVersion,
          tx,
        );
        if (!updatedDocument) {
          throw new DomainError(
            "DOCUMENT_VERSION_CONFLICT",
            "Concorrência detectada ao atualizar a versão corrente do documento.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "DOCUMENT_VERSION_RESTORED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              sourceVersionId: sourceVersion.id,
              sourceVersionNumber: sourceVersion.versionNumber,
              restoredVersionId: createdVersion.id,
              restoredVersionNumber: createdVersion.versionNumber,
              fileObjectId: fileObject.id,
            },
          },
          tx,
        );

        return {
          document: updatedDocument,
          version: createdVersion,
          fileObject,
        };
      });
    },
  };
}
