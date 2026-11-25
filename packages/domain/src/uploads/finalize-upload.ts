import { resolveCategoryTextIndexingDecision } from "../categories/category-service.js";
import type { DocumentVersionEntity, FileObjectEntity } from "../documents/document.types.js";
import { buildNextDocumentVersion } from "../documents/versioning.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { CategoryRepositoryPort } from "../ports/category-repository.port.js";
import type {
  DocumentRepositoryPort,
  DocumentVersionRepositoryPort,
} from "../ports/document-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import type {
  UploadSessionEntity,
  UploadSessionRepositoryPort,
} from "../ports/upload-session-repository.port.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const PLACEHOLDER_PENDING_CHECKSUM = "0".repeat(64);

export interface VerifiedUploadedObject {
  readonly objectKey: string;
  readonly contentLength: number;
  readonly contentType: string;
  readonly checksumSha256: string | null;
}

export interface UploadObjectVerifierPort {
  verifyUploadedObject(input: {
    readonly storageConnectionId: string;
    readonly objectKey: string;
  }): Promise<VerifiedUploadedObject | null>;
}

export interface UploadProcessingEnqueueInput {
  readonly organizationId: string;
  readonly uploadSessionId: string;
  readonly fileObjectId: string;
  readonly storageConnectionId: string;
  readonly documentId: string | null;
  readonly documentVersionId: string | null;
  readonly indexContent?: boolean | undefined;
}

export interface UploadProcessingQueuePort {
  enqueueProcessing(input: UploadProcessingEnqueueInput, tx?: TransactionContext): Promise<void>;
}

export interface FinalizeUploadCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly expectedChecksumSha256?: string | undefined;
  readonly documentId?: string | undefined;
  readonly changeNote?: string | null | undefined;
}

export interface FinalizeUploadResult {
  readonly session: UploadSessionEntity;
  readonly fileObject: FileObjectEntity;
  readonly documentVersion: DocumentVersionEntity | null;
  readonly idempotentReplay: boolean;
  readonly processingEnqueued: boolean;
}

export interface FinalizeUploadServiceDependencies {
  readonly uploads: UploadSessionRepositoryPort;
  readonly objectVerifier: UploadObjectVerifierPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly categories?: CategoryRepositoryPort | undefined;
  readonly documents?: DocumentRepositoryPort | undefined;
  readonly documentVersions?: DocumentVersionRepositoryPort | undefined;
  readonly processingQueue?: UploadProcessingQueuePort | undefined;
  readonly generateId: () => string;
  readonly now?: (() => Date) | undefined;
}

export interface FinalizeUploadService {
  finalizeUpload(command: FinalizeUploadCommand): Promise<FinalizeUploadResult>;
}

function normalizeValidSha256(
  rawChecksum: string | null | undefined,
  errorCode: string,
  errorMessage: string,
): string | null {
  if (rawChecksum === null || rawChecksum === undefined) {
    return null;
  }
  const normalized = rawChecksum.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized) || normalized === PLACEHOLDER_PENDING_CHECKSUM) {
    if (normalized === PLACEHOLDER_PENDING_CHECKSUM) {
      return null;
    }
    throw new DomainError(errorCode, errorMessage);
  }
  return normalized;
}

function normalizeChangeNote(rawNote: string | null | undefined): string | null {
  if (rawNote === null || rawNote === undefined) {
    return null;
  }
  const trimmed = rawNote.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > 1_000) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "A nota de alteração da versão não pode ultrapassar 1000 caracteres.",
    );
  }
  return trimmed;
}

function buildReplayConflictChecks(params: {
  readonly session: UploadSessionEntity;
  readonly fileObject: FileObjectEntity;
  readonly existingVersion: DocumentVersionEntity | null;
  readonly command: FinalizeUploadCommand;
  readonly normalizedExpectedChecksum: string | null;
}): void {
  if (params.fileObject.status === "UPLOADING") {
    throw new DomainError(
      "UPLOAD_SESSION_CORRUPT",
      "Sessão finalizada aponta para objeto ainda em estado de envio.",
    );
  }

  if (
    params.normalizedExpectedChecksum !== null &&
    params.fileObject.checksumSha256.toLowerCase() !== params.normalizedExpectedChecksum
  ) {
    throw new DomainError(
      "UPLOAD_CHECKSUM_MISMATCH",
      "O checksum SHA-256 informado diverge do objeto já finalizado nesta sessão.",
    );
  }

  if (params.command.documentId !== undefined) {
    if (
      !params.existingVersion ||
      params.existingVersion.documentId !== params.command.documentId
    ) {
      throw new DomainError(
        "UPLOAD_FINALIZATION_CONFLICT",
        "Repetição da finalização referencia documento incompatível com a sessão finalizada.",
      );
    }
  }
}

/**
 * Verifies uploaded object presence, declared byte length, and verified SHA-256 checksum
 * before transitioning the object atomically into `QUARANTINED`, enqueueing processing,
 * and ensuring repeated/concurrent finalization never creates duplicate document versions.
 */
export function createFinalizeUploadService(
  deps: FinalizeUploadServiceDependencies,
): FinalizeUploadService {
  const nowFn = deps.now ?? (() => new Date());

  const loadExistingVersionForFileObject = async (
    fileObjectId: string,
    tx?: TransactionContext,
  ): Promise<DocumentVersionEntity | null> => {
    if (!deps.documentVersions) {
      return null;
    }
    return deps.documentVersions.findByFileObjectId(fileObjectId, tx);
  };

  return {
    async finalizeUpload(command: FinalizeUploadCommand): Promise<FinalizeUploadResult> {
      const normalizedExpectedChecksum =
        command.expectedChecksumSha256 === undefined
          ? null
          : normalizeValidSha256(
              command.expectedChecksumSha256,
              "VALIDATION_ERROR",
              "Checksum SHA-256 esperado inválido.",
            );
      if (command.expectedChecksumSha256 !== undefined && normalizedExpectedChecksum === null) {
        throw new DomainError("VALIDATION_ERROR", "Checksum SHA-256 esperado inválido.");
      }

      const changeNote = normalizeChangeNote(command.changeNote);

      const session = await deps.uploads.findById(command.sessionId);
      if (!session || session.organizationId !== command.organizationId) {
        throw new DomainError("UPLOAD_SESSION_NOT_FOUND", "Sessão de upload não encontrada.");
      }
      if (session.userId !== command.actorUserId) {
        throw new DomainError(
          "UPLOAD_SESSION_FORBIDDEN",
          "Você não possui permissão para finalizar esta sessão de upload.",
        );
      }

      const fileObject = await deps.uploads.findFileObjectById(session.fileObjectId);
      if (!fileObject || fileObject.storageConnectionId !== session.storageConnectionId) {
        throw new DomainError(
          "UPLOAD_SESSION_CORRUPT",
          "Objeto binário associado à sessão de upload não foi encontrado.",
        );
      }

      if (session.status === "FINALIZED") {
        const existingVersion = await loadExistingVersionForFileObject(fileObject.id);
        buildReplayConflictChecks({
          session,
          fileObject,
          existingVersion,
          command,
          normalizedExpectedChecksum,
        });

        return {
          session,
          fileObject,
          documentVersion: existingVersion,
          idempotentReplay: true,
          processingEnqueued: false,
        };
      }

      if (session.status !== "PENDING" && session.status !== "UPLOADED") {
        throw new DomainError(
          "UPLOAD_SESSION_NOT_FINALIZABLE",
          "A sessão de upload não está em estado válido para finalização.",
        );
      }

      const currentTime = nowFn();
      if (new Date(session.expiresAt).getTime() <= currentTime.getTime()) {
        await deps.uploads.markSessionExpired(session.id);
        throw new DomainError("UPLOAD_SESSION_EXPIRED", "A sessão de upload expirou.");
      }

      if (fileObject.status !== "UPLOADING") {
        throw new DomainError(
          "UPLOAD_SESSION_NOT_FINALIZABLE",
          "O objeto da sessão não está pendente de finalização.",
        );
      }

      const verifiedObject = await deps.objectVerifier.verifyUploadedObject({
        storageConnectionId: session.storageConnectionId,
        objectKey: fileObject.objectKey,
      });

      if (!verifiedObject) {
        throw new DomainError(
          "UPLOAD_OBJECT_MISSING",
          "O arquivo ainda não foi encontrado no armazenamento configurado.",
        );
      }

      if (verifiedObject.objectKey !== fileObject.objectKey) {
        throw new DomainError(
          "UPLOAD_OBJECT_MISMATCH",
          "A chave verificada no armazenamento diverge da sessão autorizada.",
        );
      }

      if (
        !Number.isInteger(verifiedObject.contentLength) ||
        verifiedObject.contentLength <= 0 ||
        verifiedObject.contentLength !== session.declaredSizeBytes
      ) {
        throw new DomainError(
          "UPLOAD_SIZE_MISMATCH",
          "O tamanho do objeto armazenado diverge do tamanho declarado na sessão.",
        );
      }

      const verifiedChecksum = normalizeValidSha256(
        verifiedObject.checksumSha256,
        "UPLOAD_CHECKSUM_UNVERIFIED",
        "Checksum SHA-256 retornado pelo armazenamento possui formato inválido.",
      );
      if (!verifiedChecksum) {
        throw new DomainError(
          "UPLOAD_CHECKSUM_UNVERIFIED",
          "Não foi possível verificar o checksum SHA-256 do objeto armazenado.",
        );
      }

      if (normalizedExpectedChecksum !== null && verifiedChecksum !== normalizedExpectedChecksum) {
        throw new DomainError(
          "UPLOAD_CHECKSUM_MISMATCH",
          "O checksum SHA-256 do objeto armazenado diverge do checksum informado.",
        );
      }

      const recordedSessionChecksum = normalizeValidSha256(
        fileObject.checksumSha256,
        "UPLOAD_SESSION_CORRUPT",
        "Checksum registrado na sessão possui formato inválido.",
      );
      if (recordedSessionChecksum !== null && verifiedChecksum !== recordedSessionChecksum) {
        throw new DomainError(
          "UPLOAD_CHECKSUM_MISMATCH",
          "O checksum SHA-256 do objeto armazenado diverge do checksum registrado na sessão.",
        );
      }

      return deps.transactions.runInTransaction(async (tx) => {
        let resolvedCategoryId: string | null = session.categoryId ?? null;
        if (command.documentId !== undefined) {
          if (!deps.documents || !deps.documentVersions) {
            throw new DomainError(
              "UPLOAD_FINALIZATION_MISCONFIGURED",
              "Repositórios de documento não configurados para criação de versão.",
            );
          }

          const targetDoc = await deps.documents.findById(command.documentId, tx);
          if (!targetDoc || targetDoc.organizationId !== command.organizationId) {
            throw new DomainError(
              "DOCUMENT_NOT_FOUND",
              "Documento de destino para finalização do upload não encontrado.",
            );
          }
          if (targetDoc.status === "DELETED") {
            throw new DomainError(
              "INVALID_DOCUMENT_STATE",
              "Não é possível anexar versão a um documento excluído.",
            );
          }
          resolvedCategoryId = targetDoc.categoryId;
        }

        const targetCategory =
          resolvedCategoryId !== null && deps.categories
            ? await deps.categories.findById(resolvedCategoryId, tx)
            : null;
        const resolvedIndexContent = resolveCategoryTextIndexingDecision(
          targetCategory?.textIndexingMode ?? "NEVER",
          session.indexContentRequested ?? null,
        );

        const finalizedRecords = await deps.uploads.finalizeToQuarantine(
          {
            sessionId: session.id,
            fileObjectId: fileObject.id,
            sizeBytes: verifiedObject.contentLength,
            checksumSha256: verifiedChecksum,
            finalizedAt: nowFn(),
          },
          tx,
        );

        if (!finalizedRecords) {
          const reloadedSession = await deps.uploads.findById(session.id, tx);
          const reloadedFileObject = await deps.uploads.findFileObjectById(fileObject.id, tx);
          if (reloadedSession?.status === "FINALIZED" && reloadedFileObject) {
            const existingVersion = await loadExistingVersionForFileObject(
              reloadedFileObject.id,
              tx,
            );
            buildReplayConflictChecks({
              session: reloadedSession,
              fileObject: reloadedFileObject,
              existingVersion,
              command,
              normalizedExpectedChecksum,
            });

            return {
              session: reloadedSession,
              fileObject: reloadedFileObject,
              documentVersion: existingVersion,
              idempotentReplay: true,
              processingEnqueued: false,
            };
          }

          throw new DomainError(
            "UPLOAD_SESSION_NOT_FINALIZABLE",
            "A sessão de upload não pode ser finalizada neste estado.",
          );
        }

        let createdVersion: DocumentVersionEntity | null = null;
        if (command.documentId !== undefined && deps.documentVersions) {
          const existingForFileObject = await deps.documentVersions.findByFileObjectId(
            finalizedRecords.fileObject.id,
            tx,
          );
          if (existingForFileObject) {
            if (existingForFileObject.documentId !== command.documentId) {
              throw new DomainError(
                "UPLOAD_FINALIZATION_CONFLICT",
                "O objeto já está vinculado a outro documento.",
              );
            }
            createdVersion = existingForFileObject;
          } else {
            const existingVersions = await deps.documentVersions.listByDocumentId(
              command.documentId,
              tx,
            );
            const nextVersion = buildNextDocumentVersion({
              id: deps.generateId(),
              documentId: command.documentId,
              existingVersions,
              fileObjectId: finalizedRecords.fileObject.id,
              uploadedByUserId: command.actorUserId,
              changeNote,
              createdAt: nowFn().toISOString(),
            });

            createdVersion = await deps.documentVersions.create(
              {
                id: nextVersion.id,
                documentId: nextVersion.documentId,
                versionNumber: nextVersion.versionNumber,
                fileObjectId: nextVersion.fileObjectId,
                uploadedByUserId: nextVersion.uploadedByUserId,
                changeNote: nextVersion.changeNote,
              },
              tx,
            );
          }
        }

        let processingEnqueued = false;
        if (deps.processingQueue) {
          await deps.processingQueue.enqueueProcessing(
            {
              organizationId: command.organizationId,
              uploadSessionId: finalizedRecords.session.id,
              fileObjectId: finalizedRecords.fileObject.id,
              storageConnectionId: finalizedRecords.session.storageConnectionId,
              documentId: command.documentId ?? null,
              documentVersionId: createdVersion?.id ?? null,
              indexContent: resolvedIndexContent,
            },
            tx,
          );
          processingEnqueued = true;
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "UPLOAD_FINALIZED_TO_QUARANTINE",
            resourceType: "UPLOAD_SESSION",
            resourceId: finalizedRecords.session.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              storageConnectionId: finalizedRecords.session.storageConnectionId,
              fileObjectId: finalizedRecords.fileObject.id,
              sizeBytes: verifiedObject.contentLength,
              documentId: command.documentId ?? null,
              documentVersionId: createdVersion?.id ?? null,
              indexContent: resolvedIndexContent,
            },
          },
          tx,
        );

        return {
          session: finalizedRecords.session,
          fileObject: finalizedRecords.fileObject,
          documentVersion: createdVersion,
          idempotentReplay: false,
          processingEnqueued,
        };
      });
    },
  };
}
