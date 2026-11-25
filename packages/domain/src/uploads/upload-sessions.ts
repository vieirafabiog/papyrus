import type { FileObjectEntity } from "../documents/document.types.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { DocumentRepositoryPort } from "../ports/document-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import type {
  UploadSessionEntity,
  UploadSessionRepositoryPort,
} from "../ports/upload-session-repository.port.js";
import type { StorageRouterService } from "../storage/storage-router.js";
import {
  type EffectiveUploadPolicy,
  extractNormalizedFileExtension,
  normalizeDeclaredUploadMimeType,
} from "./upload-policy.js";

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_EXPIRATION_SECONDS = 900;
const MIN_EXPIRATION_SECONDS = 60;
const MAX_EXPIRATION_SECONDS = 3_600;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const PLACEHOLDER_PENDING_CHECKSUM = "0".repeat(64);

export interface CreateUploadSessionCommand {
  readonly organizationId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly documentId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly storageConnectionId?: string | undefined;
  readonly originalFileName: string;
  readonly declaredSizeBytes: number;
  readonly declaredContentType: string;
  readonly declaredChecksumSha256?: string | undefined;
  readonly indexContentRequested?: boolean | null | undefined;
  readonly idempotencyKey: string;
  readonly expiresInSeconds?: number | undefined;
}

export interface CreateUploadSessionResult {
  readonly session: UploadSessionEntity;
  readonly fileObject: FileObjectEntity;
  readonly idempotentReplay: boolean;
}

export interface UploadSessionServiceDependencies {
  readonly uploads: UploadSessionRepositoryPort;
  readonly documents: DocumentRepositoryPort;
  readonly storageRouter: StorageRouterService;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
  readonly maxUploadBytes?: number | undefined;
  readonly resolveUploadPolicy?:
    | ((
        organizationId: string,
      ) => Promise<
        Pick<
          EffectiveUploadPolicy,
          | "maxFileSizeBytes"
          | "allowedExtensions"
          | "allowedMimeTypes"
          | "enforceDeclaredExtensionMatch"
        >
      >)
    | undefined;
  readonly defaultExpirationSeconds?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface UploadSessionService {
  createSession(command: CreateUploadSessionCommand): Promise<CreateUploadSessionResult>;
}

function sanitizeOriginalFileName(rawName: string): string {
  const baseName = rawName.split(/[/\\]/).pop() ?? "";
  let clean = "";
  for (let i = 0; i < baseName.length; i += 1) {
    const ch = baseName[i];
    const code = baseName.charCodeAt(i);
    if (!ch || code <= 0x1f || code === 0x7f) {
      continue;
    }
    clean += ch;
  }
  const trimmed = clean.trim().slice(0, 255);
  if (trimmed.length === 0 || trimmed === "." || trimmed === "..") {
    throw new DomainError("VALIDATION_ERROR", "Nome original do arquivo inválido para upload.");
  }
  return trimmed;
}

function buildOpaqueObjectKey(params: {
  readonly organizationId: string;
  readonly documentRefId: string;
  readonly versionRefId: string;
  readonly fileObjectId: string;
}): string {
  return `org/${params.organizationId}/documents/${params.documentRefId}/versions/${params.versionRefId}/${params.fileObjectId}`;
}

/**
 * Creates pending upload sessions bound to the authenticated user, resolved storage
 * destination, declared byte length, expiration window, and idempotency key without
 * creating an available document version prematurely.
 */
export function createUploadSessionService(
  deps: UploadSessionServiceDependencies,
): UploadSessionService {
  const maxUploadBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const defaultExpirationSeconds = deps.defaultExpirationSeconds ?? DEFAULT_EXPIRATION_SECONDS;
  const now = deps.now ?? (() => new Date());

  return {
    async createSession(command: CreateUploadSessionCommand): Promise<CreateUploadSessionResult> {
      const idempotencyKey = command.idempotencyKey.trim();
      if (idempotencyKey.length === 0 || idempotencyKey.length > 128) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "Chave de idempotência inválida para sessão de upload.",
        );
      }

      if (!Number.isInteger(command.declaredSizeBytes) || command.declaredSizeBytes <= 0) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "Tamanho declarado do arquivo deve ser um inteiro positivo.",
        );
      }

      const activePolicy = deps.resolveUploadPolicy
        ? await deps.resolveUploadPolicy(command.organizationId)
        : null;
      const effectiveMaxUploadBytes = activePolicy
        ? Math.min(maxUploadBytes, activePolicy.maxFileSizeBytes)
        : maxUploadBytes;

      if (command.declaredSizeBytes > effectiveMaxUploadBytes) {
        throw new DomainError(
          "UPLOAD_TOO_LARGE",
          `O tamanho declarado excede o limite máximo permitido para upload (${effectiveMaxUploadBytes} bytes).`,
        );
      }

      const declaredContentType = command.declaredContentType.trim();
      if (declaredContentType.length === 0 || declaredContentType.length > 255) {
        throw new DomainError("VALIDATION_ERROR", "Content-Type declarado inválido.");
      }

      const originalFileName = sanitizeOriginalFileName(command.originalFileName);

      if (activePolicy) {
        const ext = extractNormalizedFileExtension(originalFileName);
        if (!ext || !activePolicy.allowedExtensions.includes(ext)) {
          throw new DomainError(
            "EXTENSION_NOT_ALLOWED",
            "A extensão do arquivo não é permitida pela política de upload configurada.",
          );
        }

        const normalizedMime = normalizeDeclaredUploadMimeType(declaredContentType);
        if (
          activePolicy.enforceDeclaredExtensionMatch &&
          normalizedMime &&
          normalizedMime !== "application/octet-stream" &&
          !activePolicy.allowedMimeTypes.includes(normalizedMime)
        ) {
          throw new DomainError(
            "MIME_NOT_ALLOWED",
            "O formato declarado do arquivo não é permitido pela política de upload configurada.",
          );
        }
      }

      let initialChecksum = PLACEHOLDER_PENDING_CHECKSUM;
      if (command.declaredChecksumSha256 !== undefined) {
        const trimmedChecksum = command.declaredChecksumSha256.trim().toLowerCase();
        if (!SHA256_HEX_PATTERN.test(trimmedChecksum)) {
          throw new DomainError("VALIDATION_ERROR", "Checksum SHA-256 declarado inválido.");
        }
        initialChecksum = trimmedChecksum;
      }

      const ttlSeconds = command.expiresInSeconds ?? defaultExpirationSeconds;
      if (
        !Number.isInteger(ttlSeconds) ||
        ttlSeconds < MIN_EXPIRATION_SECONDS ||
        ttlSeconds > MAX_EXPIRATION_SECONDS
      ) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "Tempo de expiração da sessão de upload fora dos limites permitidos.",
        );
      }

      return deps.transactions.runInTransaction(async (tx) => {
        const existingSession = await deps.uploads.findByIdempotencyKey(
          command.organizationId,
          command.userId,
          idempotencyKey,
          tx,
        );

        if (existingSession) {
          if (
            existingSession.declaredSizeBytes !== command.declaredSizeBytes ||
            existingSession.declaredContentType !== declaredContentType
          ) {
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "Chave de idempotência já utilizada para outra sessão de upload.",
            );
          }

          const existingFileObject = await deps.uploads.findFileObjectById(
            existingSession.fileObjectId,
            tx,
          );
          if (!existingFileObject) {
            throw new DomainError(
              "UPLOAD_SESSION_CORRUPT",
              "Objeto binário associado à sessão de upload não foi encontrado.",
            );
          }

          return {
            session: existingSession,
            fileObject: existingFileObject,
            idempotentReplay: true,
          };
        }

        let routingCategoryId = command.categoryId ?? null;
        if (command.documentId) {
          const doc = await deps.documents.findById(command.documentId, tx);
          if (!doc || doc.organizationId !== command.organizationId) {
            throw new DomainError(
              "DOCUMENT_NOT_FOUND",
              "Documento de destino da sessão de upload não encontrado.",
            );
          }
          routingCategoryId = doc.categoryId;
        }

        const resolvedTarget = await deps.storageRouter.resolveWriteTarget(
          {
            organizationId: command.organizationId,
            categoryId: routingCategoryId,
            explicitConnectionId: command.storageConnectionId,
          },
          tx,
        );

        const sessionId = deps.generateId();
        const fileObjectId = deps.generateId();
        const documentRefId = command.documentId ?? deps.generateId();
        const versionRefId = deps.generateId();
        const objectKey = buildOpaqueObjectKey({
          organizationId: command.organizationId,
          documentRefId,
          versionRefId,
          fileObjectId,
        });

        const expiresAt = new Date(now().getTime() + ttlSeconds * 1000);

        const created = await deps.uploads.createSessionWithFileObject(
          {
            sessionId,
            organizationId: command.organizationId,
            userId: command.userId,
            storageConnectionId: resolvedTarget.connection.id,
            fileObjectId,
            categoryId: routingCategoryId,
            objectKey,
            originalFileName,
            declaredSizeBytes: command.declaredSizeBytes,
            declaredContentType,
            checksumSha256: initialChecksum,
            indexContentRequested: command.indexContentRequested ?? null,
            idempotencyKey,
            expiresAt,
          },
          tx,
        );

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.userId,
            action: "UPLOAD_SESSION_CREATED",
            resourceType: "UPLOAD_SESSION",
            resourceId: created.session.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              storageConnectionId: created.session.storageConnectionId,
              declaredSizeBytes: created.session.declaredSizeBytes,
            },
          },
          tx,
        );

        return {
          session: created.session,
          fileObject: created.fileObject,
          idempotentReplay: false,
        };
      });
    },
  };
}
