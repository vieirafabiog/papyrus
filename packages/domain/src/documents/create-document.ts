import { createAuditWriter } from "../audit/audit-writer.js";
import { resolveCategoryTextIndexingDecision } from "../categories/category-service.js";
import type { CategoryFieldDefinition } from "../categories/metadata-validation.js";
import { validateDocumentMetadata } from "../categories/metadata-validation.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { CategoryRepositoryPort } from "../ports/category-repository.port.js";
import type {
  DocumentRepositoryPort,
  DocumentVersionRepositoryPort,
} from "../ports/document-repository.port.js";
import type { FolderRepositoryPort } from "../ports/folder-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import type { UploadSessionRepositoryPort } from "../ports/upload-session-repository.port.js";
import type { UserRepositoryPort } from "../ports/user-repository.port.js";
import type { DocumentTextIndexingQueuePort } from "../uploads/finalize-upload.js";
import { canSubmitDocumentForReview } from "./document-state.js";
import type {
  DocumentEntity,
  DocumentMetadataMap,
  DocumentStatus,
  DocumentVersionEntity,
  FileObjectEntity,
} from "./document.types.js";
import { buildNextDocumentVersion } from "./versioning.js";

export const MAX_DOCUMENT_TITLE_LENGTH = 255;

export interface CreateDocumentServiceDependencies {
  readonly documents: DocumentRepositoryPort;
  readonly documentVersions: DocumentVersionRepositoryPort;
  readonly categories: CategoryRepositoryPort;
  readonly folders: FolderRepositoryPort;
  readonly users: UserRepositoryPort;
  readonly uploadSessions: UploadSessionRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly textIndexingQueue?: DocumentTextIndexingQueuePort | undefined;
  readonly generateId: () => string;
  readonly now?: (() => Date) | undefined;
}

export interface CreateDocumentCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly title: string;
  readonly categoryId: string;
  readonly folderId: string | null;
  readonly ownerUserId?: string | undefined;
  readonly issueDate: string | null;
  readonly expirationDate: string | null;
  readonly metadata: DocumentMetadataMap;
  readonly uploadSessionId: string;
  readonly changeNote?: string | null | undefined;
  readonly initialStatus?: DocumentStatus | undefined;
}

export interface CreatedDocumentResult {
  readonly document: DocumentEntity;
  readonly initialVersion: DocumentVersionEntity;
  readonly fileObject: FileObjectEntity;
}

export interface CreateDocumentService {
  createDocument(command: CreateDocumentCommand): Promise<CreatedDocumentResult>;
}

/**
 * Normalizes and validates initial document creation status.
 * Initial submission can never bypass review/approval workflow directly into APPROVED or terminal states.
 */
export function resolveInitialDocumentStatus(
  requestedStatus: DocumentStatus | undefined,
): "DRAFT" | "IN_REVIEW" {
  if (requestedStatus === undefined || requestedStatus === "DRAFT") {
    return "DRAFT";
  }
  if (requestedStatus === "APPROVED") {
    throw new DomainError(
      "INVALID_INITIAL_DOCUMENT_STATUS",
      "Não é permitido criar um documento já com status aprovado no envio inicial.",
    );
  }
  if (requestedStatus === "IN_REVIEW") {
    return "IN_REVIEW";
  }
  throw new DomainError(
    "INVALID_INITIAL_DOCUMENT_STATUS",
    "Status inicial inválido para criação do documento. Utilize DRAFT ou IN_REVIEW.",
  );
}

/**
 * Validates and normalizes the document title.
 */
export function normalizeDocumentTitle(rawTitle: string): string {
  const normalized = rawTitle.trim();
  if (normalized.length === 0) {
    throw new DomainError("INVALID_DOCUMENT_TITLE", "O título do documento é obrigatório.");
  }
  if (normalized.length > MAX_DOCUMENT_TITLE_LENGTH) {
    throw new DomainError(
      "INVALID_DOCUMENT_TITLE",
      `O título do documento deve ter no máximo ${MAX_DOCUMENT_TITLE_LENGTH} caracteres.`,
    );
  }
  return normalized;
}

function assertValidDateRange(issueDate: string | null, expirationDate: string | null): void {
  if (issueDate !== null && expirationDate !== null && expirationDate < issueDate) {
    throw new DomainError(
      "INVALID_DOCUMENT_DATES",
      "A data de vencimento não pode ser anterior à data de emissão.",
    );
  }
}

/**
 * Creates the domain use case that validates taxonomy, owner, metadata, initial status,
 * and links a finalized upload session as version 1 of the newly created document.
 */
export function createDocumentUseCase(
  deps: CreateDocumentServiceDependencies,
): CreateDocumentService {
  const now = deps.now ?? (() => new Date());
  const auditWriter = createAuditWriter({ repository: deps.audit });

  return {
    async createDocument(command: CreateDocumentCommand): Promise<CreatedDocumentResult> {
      const title = normalizeDocumentTitle(command.title);
      const targetInitialStatus = resolveInitialDocumentStatus(command.initialStatus);
      assertValidDateRange(command.issueDate, command.expirationDate);
      const ownerUserId = command.ownerUserId ?? command.actorUserId;
      const changeNote =
        command.changeNote && command.changeNote.trim().length > 0
          ? command.changeNote.trim()
          : null;

      return deps.transactions.runInTransaction(async (tx) => {
        const category = await deps.categories.findById(command.categoryId, tx);
        if (!category || category.organizationId !== command.organizationId) {
          throw new DomainError("CATEGORY_NOT_FOUND", "Categoria não encontrada.");
        }
        if (!category.isActive) {
          throw new DomainError(
            "CATEGORY_INACTIVE",
            "Não é possível criar documentos em uma categoria desativada.",
          );
        }

        const fields = await deps.categories.listFields(category.id, tx);
        const fieldDefinitions: readonly CategoryFieldDefinition[] = fields.map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required,
          options: field.options ?? undefined,
        }));
        const metadataResult = validateDocumentMetadata(fieldDefinitions, command.metadata);
        if (!metadataResult.valid) {
          const summary = metadataResult.issues
            .map((issue) => `${issue.fieldKey}: ${issue.reason}`)
            .join("; ");
          throw new DomainError(
            "INVALID_DOCUMENT_METADATA",
            `Metadados inválidos para a categoria selecionada: ${summary}`,
          );
        }

        if (command.folderId !== null) {
          const folder = await deps.folders.findById(command.folderId, tx);
          if (!folder || folder.organizationId !== command.organizationId) {
            throw new DomainError("FOLDER_NOT_FOUND", "Pasta não encontrada.");
          }
          if (folder.status !== "ACTIVE") {
            throw new DomainError(
              "FOLDER_ARCHIVED",
              "Não é possível criar documentos dentro de uma pasta arquivada.",
            );
          }
        }

        const owner = await deps.users.findById(ownerUserId, tx);
        if (!owner || owner.organizationId !== command.organizationId) {
          throw new DomainError(
            "OWNER_USER_NOT_FOUND",
            "Usuário responsável não encontrado na organização.",
          );
        }
        if (owner.status !== "ACTIVE") {
          throw new DomainError(
            "OWNER_USER_INACTIVE",
            "O usuário responsável pelo documento precisa estar ativo.",
          );
        }

        const uploadSession = await deps.uploadSessions.findById(command.uploadSessionId, tx);
        if (!uploadSession || uploadSession.organizationId !== command.organizationId) {
          throw new DomainError("UPLOAD_SESSION_NOT_FOUND", "Sessão de upload não encontrada.");
        }
        if (uploadSession.userId !== command.actorUserId) {
          throw new DomainError(
            "UPLOAD_SESSION_FORBIDDEN",
            "A sessão de upload informada pertence a outro usuário.",
          );
        }
        if (uploadSession.status !== "FINALIZED") {
          throw new DomainError(
            "UPLOAD_NOT_FINALIZED",
            "O upload precisa estar finalizado antes de criar o registro documental.",
          );
        }

        const fileObject = await deps.uploadSessions.findFileObjectById(
          uploadSession.fileObjectId,
          tx,
        );
        if (!fileObject) {
          throw new DomainError("FILE_OBJECT_NOT_FOUND", "Arquivo do upload não encontrado.");
        }
        if (fileObject.status !== "QUARANTINED" && fileObject.status !== "AVAILABLE") {
          throw new DomainError(
            "FILE_OBJECT_NOT_USABLE",
            "O arquivo vinculado não está disponível ou foi rejeitado na verificação.",
          );
        }

        const existingVersion = await deps.documentVersions.findByFileObjectId(fileObject.id, tx);
        if (existingVersion) {
          throw new DomainError(
            "FILE_ALREADY_LINKED_TO_DOCUMENT",
            "Este upload já foi vinculado a um documento existente.",
          );
        }

        if (
          targetInitialStatus === "IN_REVIEW" &&
          !canSubmitDocumentForReview("DRAFT", fileObject.status)
        ) {
          throw new DomainError(
            "DOCUMENT_NOT_READY_FOR_REVIEW",
            "O arquivo ainda está em quarentena ou indisponível para envio direto à revisão.",
          );
        }

        const documentId = deps.generateId();
        const createdDocument = await deps.documents.create(
          {
            id: documentId,
            organizationId: command.organizationId,
            title,
            categoryId: category.id,
            folderId: command.folderId,
            ownerUserId: owner.id,
            issueDate: command.issueDate,
            expirationDate: command.expirationDate,
            metadata: metadataResult.normalizedMetadata,
          },
          tx,
        );

        const versionId = deps.generateId();
        const versionCandidate = buildNextDocumentVersion({
          id: versionId,
          documentId: createdDocument.id,
          existingVersions: [],
          fileObjectId: fileObject.id,
          uploadedByUserId: command.actorUserId,
          changeNote,
          createdAt: now().toISOString(),
        });

        const initialVersion = await deps.documentVersions.create(
          {
            id: versionCandidate.id,
            documentId: versionCandidate.documentId,
            versionNumber: versionCandidate.versionNumber,
            fileObjectId: versionCandidate.fileObjectId,
            uploadedByUserId: versionCandidate.uploadedByUserId,
            changeNote: versionCandidate.changeNote,
          },
          tx,
        );

        let finalDocument = await deps.documents.setCurrentVersion(
          createdDocument.id,
          initialVersion.id,
          createdDocument.version,
          tx,
        );
        if (!finalDocument) {
          throw new DomainError(
            "DOCUMENT_VERSION_CONFLICT",
            "Falha ao vincular versão inicial ao documento.",
          );
        }

        if (targetInitialStatus === "IN_REVIEW") {
          const updatedStatusDoc = await deps.documents.updateStatus(
            finalDocument.id,
            "IN_REVIEW",
            finalDocument.version,
            tx,
          );
          if (!updatedStatusDoc) {
            throw new DomainError(
              "DOCUMENT_VERSION_CONFLICT",
              "Falha ao definir status inicial do documento.",
            );
          }
          finalDocument = updatedStatusDoc;
        }

        if (deps.documents.syncMetadataRows && fields.length > 0) {
          await deps.documents.syncMetadataRows(
            {
              documentId: finalDocument.id,
              fields,
              metadata: metadataResult.normalizedMetadata,
            },
            tx,
          );
        }

        if (
          fileObject.status === "AVAILABLE" &&
          deps.textIndexingQueue &&
          resolveCategoryTextIndexingDecision(
            category.textIndexingMode,
            uploadSession.indexContentRequested ?? null,
          )
        ) {
          await deps.textIndexingQueue.enqueueIndexing(
            {
              organizationId: command.organizationId,
              documentId: finalDocument.id,
              documentVersionId: initialVersion.id,
              fileObjectId: fileObject.id,
              storageConnectionId: uploadSession.storageConnectionId,
            },
            tx,
          );
        }

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "DOCUMENT_CREATED",
            resourceType: "DOCUMENT",
            resourceId: finalDocument.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              categoryId: finalDocument.categoryId,
              folderId: finalDocument.folderId,
              ownerUserId: finalDocument.ownerUserId,
              uploadSessionId: uploadSession.id,
              fileObjectId: fileObject.id,
              initialStatus: finalDocument.status,
            },
          },
          tx,
        );

        return {
          document: finalDocument,
          initialVersion,
          fileObject,
        };
      });
    },
  };
}
