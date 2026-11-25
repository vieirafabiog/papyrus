import { createAuditWriter } from "../audit/audit-writer.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type {
  DocumentRepositoryPort,
  DocumentVersionRepositoryPort,
} from "../ports/document-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import type { UploadSessionRepositoryPort } from "../ports/upload-session-repository.port.js";
import { isFileObjectDownloadable } from "./document-state.js";
import type { DocumentVersionEntity, FileObjectEntity } from "./document.types.js";

export const SHARE_MIN_TTL_MINUTES = 5;
export const SHARE_MAX_TTL_MINUTES = 30 * 24 * 60;
export const SHARE_MAX_USES_LIMIT = 1000;
export const SHARE_MIN_PASSCODE_LENGTH = 6;
export const SHARE_MAX_PASSCODE_LENGTH = 128;
export const SHARE_UNLOCK_TTL_SECONDS = 300;

export type ShareLinkStatus = "ACTIVE" | "EXPIRED" | "REVOKED" | "EXHAUSTED";
export type ShareDeliveryMode = "PREVIEW" | "DOWNLOAD";

export interface DocumentShareLinkEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly tokenHash: string;
  readonly label: string | null;
  readonly allowDownload: boolean;
  readonly passcodeHash: string | null;
  readonly maxUses: number | null;
  readonly useCount: number;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedByUserId: string | null;
  readonly lastAccessedAt: string | null;
  readonly createdBy: {
    readonly id: string;
    readonly fullName: string;
  };
  readonly createdAt: string;
}

export interface CreateDocumentShareLinkRecordInput {
  readonly id: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly tokenHash: string;
  readonly label: string | null;
  readonly allowDownload: boolean;
  readonly passcodeHash: string | null;
  readonly maxUses: number | null;
  readonly expiresAt: Date;
  readonly createdByUserId: string;
  readonly createdAt: Date;
}

export interface DocumentShareLinkRepositoryPort {
  create(
    input: CreateDocumentShareLinkRecordInput,
    tx?: TransactionContext,
  ): Promise<DocumentShareLinkEntity>;
  listByDocument(
    input: {
      readonly organizationId: string;
      readonly documentId: string;
    },
    tx?: TransactionContext,
  ): Promise<readonly DocumentShareLinkEntity[]>;
  findById(id: string, tx?: TransactionContext): Promise<DocumentShareLinkEntity | null>;
  findByTokenHash(
    tokenHash: string,
    tx?: TransactionContext,
  ): Promise<DocumentShareLinkEntity | null>;
  revokeById(
    input: {
      readonly id: string;
      readonly revokedByUserId: string;
      readonly revokedAt: Date;
    },
    tx?: TransactionContext,
  ): Promise<DocumentShareLinkEntity | null>;
  consumeUseAtomically(
    input: {
      readonly id: string;
      readonly now: Date;
    },
    tx?: TransactionContext,
  ): Promise<DocumentShareLinkEntity | null>;
}

export interface ShareLinkCryptoPort {
  generateRawToken(): string;
  hashToken(rawToken: string): string;
  hashPasscode(plainPasscode: string): Promise<string>;
  verifyPasscode(plainPasscode: string, storedHash: string): Promise<boolean>;
  issueUnlockProof(tokenHash: string, expiresAtEpochSeconds: number): string;
  verifyUnlockProof(tokenHash: string, unlockToken: string, nowEpochSeconds: number): boolean;
}

export interface DocumentShareServiceDependencies {
  readonly shareLinks: DocumentShareLinkRepositoryPort;
  readonly documents: DocumentRepositoryPort;
  readonly documentVersions: DocumentVersionRepositoryPort;
  readonly uploads: UploadSessionRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly crypto: ShareLinkCryptoPort;
  readonly generateId: () => string;
  readonly now?: (() => Date) | undefined;
}

export interface CreateDocumentShareLinkCommand {
  readonly organizationId: string;
  readonly documentId: string;
  readonly versionId?: string | null | undefined;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly ipAddress?: string | undefined;
  readonly expiresInMinutes: number;
  readonly maxUses?: number | null | undefined;
  readonly allowDownload: boolean;
  readonly passcode?: string | null | undefined;
  readonly label?: string | null | undefined;
}

export interface RevokeDocumentShareLinkCommand {
  readonly organizationId: string;
  readonly documentId: string;
  readonly shareLinkId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly ipAddress?: string | undefined;
}

export interface PublicShareMetadataResult {
  readonly shareLinkId: string;
  readonly title: string;
  readonly originalFileName: string;
  readonly detectedContentType: string;
  readonly sizeBytes: number;
  readonly allowDownload: boolean;
  readonly requiresPasscode: boolean;
  readonly unlocked: boolean;
  readonly expiresAt: string;
  readonly maxUses: number | null;
  readonly remainingUses: number | null;
}

export interface PublicShareDeliveryTarget {
  readonly shareLink: DocumentShareLinkEntity;
  readonly organizationId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly version: DocumentVersionEntity;
  readonly fileObject: FileObjectEntity;
}

export function computeShareLinkStatus(
  link: DocumentShareLinkEntity,
  referenceNow: Date,
): ShareLinkStatus {
  if (link.revokedAt !== null) {
    return "REVOKED";
  }
  if (new Date(link.expiresAt).getTime() <= referenceNow.getTime()) {
    return "EXPIRED";
  }
  if (link.maxUses !== null && link.useCount >= link.maxUses) {
    return "EXHAUSTED";
  }
  return "ACTIVE";
}

export interface DocumentShareService {
  createShareLink(command: CreateDocumentShareLinkCommand): Promise<{
    readonly link: DocumentShareLinkEntity;
    readonly shareToken: string;
  }>;
  listShareLinks(input: {
    readonly organizationId: string;
    readonly documentId: string;
  }): Promise<readonly DocumentShareLinkEntity[]>;
  revokeShareLink(command: RevokeDocumentShareLinkCommand): Promise<DocumentShareLinkEntity>;
  getPublicMetadata(input: {
    readonly rawToken: string;
    readonly unlockToken?: string | undefined;
  }): Promise<PublicShareMetadataResult>;
  unlockPublicShare(input: {
    readonly rawToken: string;
    readonly passcode: string;
    readonly requestId: string;
    readonly ipAddress?: string | undefined;
  }): Promise<{ readonly unlockToken: string; readonly expiresInSeconds: number }>;
  consumeForDelivery(input: {
    readonly rawToken: string;
    readonly delivery: ShareDeliveryMode;
    readonly unlockToken?: string | undefined;
    readonly requestId: string;
    readonly ipAddress?: string | undefined;
  }): Promise<PublicShareDeliveryTarget>;
  recordAccessDenied(input: {
    readonly rawToken: string;
    readonly reason: string;
    readonly requestId: string;
    readonly ipAddress?: string | undefined;
  }): Promise<void>;
}

/**
 * Orchestrates temporary, hashed-token document share links with strict TTL caps,
 * optional Argon2id passcode protection, atomic max-use enforcement, quarantine gating,
 * and complete security audit logging.
 */
export function createDocumentShareService(
  deps: DocumentShareServiceDependencies,
): DocumentShareService {
  const now = deps.now ?? (() => new Date());
  const auditWriter = createAuditWriter({ repository: deps.audit });

  async function resolveActivePublicBundle(rawToken: string): Promise<{
    readonly link: DocumentShareLinkEntity;
    readonly documentTitle: string;
    readonly version: DocumentVersionEntity;
    readonly fileObject: FileObjectEntity;
  }> {
    const trimmed = rawToken.trim();
    if (trimmed.length < 24 || trimmed.length > 256) {
      throw new DomainError(
        "SHARE_LINK_UNAVAILABLE",
        "Link de compartilhamento indisponível, expirado ou revogado.",
      );
    }

    const tokenHash = deps.crypto.hashToken(trimmed);
    const link = await deps.shareLinks.findByTokenHash(tokenHash);
    const currentNow = now();
    if (!link || computeShareLinkStatus(link, currentNow) !== "ACTIVE") {
      throw new DomainError(
        "SHARE_LINK_UNAVAILABLE",
        "Link de compartilhamento indisponível, expirado ou revogado.",
      );
    }

    const doc = await deps.documents.findById(link.documentId);
    if (!doc || doc.organizationId !== link.organizationId || doc.status === "DELETED") {
      throw new DomainError(
        "SHARE_LINK_UNAVAILABLE",
        "Link de compartilhamento indisponível, expirado ou revogado.",
      );
    }

    const version = await deps.documentVersions.findById(link.documentVersionId);
    if (!version || version.documentId !== doc.id) {
      throw new DomainError(
        "SHARE_LINK_UNAVAILABLE",
        "Link de compartilhamento indisponível, expirado ou revogado.",
      );
    }

    if (deps.uploads.findFileObjectOrganizationId) {
      const ownerOrgId = await deps.uploads.findFileObjectOrganizationId(version.fileObjectId);
      if (!ownerOrgId || ownerOrgId !== link.organizationId) {
        throw new DomainError(
          "SHARE_LINK_UNAVAILABLE",
          "Link de compartilhamento indisponível, expirado ou revogado.",
        );
      }
    }

    const fileObject = await deps.uploads.findFileObjectById(version.fileObjectId);
    if (!fileObject || !isFileObjectDownloadable(fileObject.status)) {
      throw new DomainError(
        "FILE_QUARANTINED",
        "Este arquivo não está liberado para acesso externo pela verificação de segurança.",
      );
    }

    return {
      link,
      documentTitle: doc.title,
      version,
      fileObject,
    };
  }

  function isUnlockSatisfied(link: DocumentShareLinkEntity, unlockToken?: string): boolean {
    if (link.passcodeHash === null) {
      return true;
    }
    if (!unlockToken || unlockToken.trim().length === 0) {
      return false;
    }
    const nowSeconds = Math.floor(now().getTime() / 1000);
    return deps.crypto.verifyUnlockProof(link.tokenHash, unlockToken.trim(), nowSeconds);
  }

  return {
    async createShareLink(command: CreateDocumentShareLinkCommand) {
      if (
        !Number.isInteger(command.expiresInMinutes) ||
        command.expiresInMinutes < SHARE_MIN_TTL_MINUTES ||
        command.expiresInMinutes > SHARE_MAX_TTL_MINUTES
      ) {
        throw new DomainError(
          "INVALID_SHARE_TTL",
          `A validade do link deve ficar entre ${SHARE_MIN_TTL_MINUTES} minutos e 30 dias.`,
        );
      }

      if (
        command.maxUses !== undefined &&
        command.maxUses !== null &&
        (!Number.isInteger(command.maxUses) ||
          command.maxUses < 1 ||
          command.maxUses > SHARE_MAX_USES_LIMIT)
      ) {
        throw new DomainError(
          "INVALID_SHARE_MAX_USES",
          `O limite de acessos deve ficar entre 1 e ${SHARE_MAX_USES_LIMIT}.`,
        );
      }

      const cleanPasscode =
        typeof command.passcode === "string" && command.passcode.length > 0
          ? command.passcode
          : null;
      if (
        cleanPasscode !== null &&
        (cleanPasscode.length < SHARE_MIN_PASSCODE_LENGTH ||
          cleanPasscode.length > SHARE_MAX_PASSCODE_LENGTH)
      ) {
        throw new DomainError(
          "INVALID_SHARE_PASSCODE",
          `A senha do link deve ter entre ${SHARE_MIN_PASSCODE_LENGTH} e ${SHARE_MAX_PASSCODE_LENGTH} caracteres.`,
        );
      }

      const normalizedLabel =
        command.label && command.label.trim().length > 0 ? command.label.trim() : null;
      const passcodeHash = cleanPasscode ? await deps.crypto.hashPasscode(cleanPasscode) : null;

      return deps.transactions.runInTransaction(async (tx) => {
        const doc = await deps.documents.findById(command.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }
        if (doc.status === "DELETED") {
          throw new DomainError(
            "DOCUMENT_DELETED_SHARE_FORBIDDEN",
            "Não é possível compartilhar documentos na lixeira.",
          );
        }

        const targetVersionId = command.versionId ?? doc.currentVersionId;
        if (!targetVersionId) {
          throw new DomainError(
            "DOCUMENT_VERSION_REQUIRED",
            "Este documento ainda não possui uma versão de arquivo disponível para compartilhamento.",
          );
        }

        const version = await deps.documentVersions.findById(targetVersionId, tx);
        if (!version || version.documentId !== doc.id) {
          throw new DomainError("VERSION_NOT_FOUND", "Versão documental não encontrada.");
        }

        const fileObject = await deps.uploads.findFileObjectById(version.fileObjectId, tx);
        if (!fileObject || !isFileObjectDownloadable(fileObject.status)) {
          throw new DomainError(
            "FILE_NOT_AVAILABLE_FOR_SHARE",
            "Apenas versões verificadas e liberadas podem ser compartilhadas externamente.",
          );
        }

        const rawToken = deps.crypto.generateRawToken();
        const tokenHash = deps.crypto.hashToken(rawToken);
        const createdAt = now();
        const expiresAt = new Date(createdAt.getTime() + command.expiresInMinutes * 60_000);
        const linkId = deps.generateId();

        const created = await deps.shareLinks.create(
          {
            id: linkId,
            organizationId: command.organizationId,
            documentId: doc.id,
            documentVersionId: version.id,
            tokenHash,
            label: normalizedLabel,
            allowDownload: command.allowDownload,
            passcodeHash,
            maxUses: command.maxUses ?? null,
            expiresAt,
            createdByUserId: command.actorUserId,
            createdAt,
          },
          tx,
        );

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "DOCUMENT_SHARE_LINK_CREATED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: command.requestId,
            ipAddress: command.ipAddress,
            metadata: {
              shareLinkId: created.id,
              documentVersionId: version.id,
              allowDownload: created.allowDownload,
              hasPasscode: created.passcodeHash !== null,
              maxUses: created.maxUses,
              expiresAt: created.expiresAt,
            },
          },
          tx,
        );

        return {
          link: created,
          shareToken: rawToken,
        };
      });
    },

    async listShareLinks(input) {
      return deps.shareLinks.listByDocument(input);
    },

    async revokeShareLink(
      command: RevokeDocumentShareLinkCommand,
    ): Promise<DocumentShareLinkEntity> {
      return deps.transactions.runInTransaction(async (tx) => {
        const doc = await deps.documents.findById(command.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }

        const existing = await deps.shareLinks.findById(command.shareLinkId, tx);
        if (
          !existing ||
          existing.organizationId !== command.organizationId ||
          existing.documentId !== doc.id
        ) {
          throw new DomainError("SHARE_LINK_NOT_FOUND", "Link de compartilhamento não encontrado.");
        }

        if (existing.revokedAt !== null) {
          return existing;
        }

        const revoked = await deps.shareLinks.revokeById(
          {
            id: existing.id,
            revokedByUserId: command.actorUserId,
            revokedAt: now(),
          },
          tx,
        );
        if (!revoked) {
          return existing;
        }

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "DOCUMENT_SHARE_LINK_REVOKED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: command.requestId,
            ipAddress: command.ipAddress,
            metadata: {
              shareLinkId: revoked.id,
            },
          },
          tx,
        );

        return revoked;
      });
    },

    async getPublicMetadata({ rawToken, unlockToken }): Promise<PublicShareMetadataResult> {
      const { link, documentTitle, fileObject } = await resolveActivePublicBundle(rawToken);
      const remainingUses =
        link.maxUses !== null ? Math.max(0, link.maxUses - link.useCount) : null;

      return {
        shareLinkId: link.id,
        title: documentTitle,
        originalFileName: fileObject.originalFileName,
        detectedContentType: fileObject.detectedContentType,
        sizeBytes: fileObject.sizeBytes,
        allowDownload: link.allowDownload,
        requiresPasscode: link.passcodeHash !== null,
        unlocked: isUnlockSatisfied(link, unlockToken),
        expiresAt: link.expiresAt,
        maxUses: link.maxUses,
        remainingUses,
      };
    },

    async unlockPublicShare({ rawToken, passcode, requestId, ipAddress }) {
      const { link } = await resolveActivePublicBundle(rawToken);
      if (link.passcodeHash !== null) {
        const ok = await deps.crypto.verifyPasscode(passcode, link.passcodeHash);
        if (!ok) {
          await auditWriter.write({
            organizationId: link.organizationId,
            actorUserId: null,
            action: "DOCUMENT_SHARE_LINK_DENIED",
            resourceType: "DOCUMENT",
            resourceId: link.documentId,
            result: "DENIED",
            requestId,
            ipAddress,
            metadata: {
              shareLinkId: link.id,
              reason: "INVALID_PASSCODE",
            },
          });
          throw new DomainError("SHARE_PASSCODE_INVALID", "Senha incorreta para este link.");
        }
      }

      const nowSeconds = Math.floor(now().getTime() / 1000);
      const unlockToken = deps.crypto.issueUnlockProof(
        link.tokenHash,
        nowSeconds + SHARE_UNLOCK_TTL_SECONDS,
      );

      return {
        unlockToken,
        expiresInSeconds: SHARE_UNLOCK_TTL_SECONDS,
      };
    },

    async consumeForDelivery({ rawToken, delivery, unlockToken, requestId, ipAddress }) {
      const bundle = await resolveActivePublicBundle(rawToken);

      if (!isUnlockSatisfied(bundle.link, unlockToken)) {
        await auditWriter.write({
          organizationId: bundle.link.organizationId,
          actorUserId: null,
          action: "DOCUMENT_SHARE_LINK_DENIED",
          resourceType: "DOCUMENT",
          resourceId: bundle.link.documentId,
          result: "DENIED",
          requestId,
          ipAddress,
          metadata: {
            shareLinkId: bundle.link.id,
            reason: "PASSCODE_REQUIRED",
          },
        });
        throw new DomainError(
          "SHARE_PASSCODE_REQUIRED",
          "Este link exige desbloqueio com senha antes de acessar o arquivo.",
        );
      }

      if (delivery === "DOWNLOAD" && !bundle.link.allowDownload) {
        await auditWriter.write({
          organizationId: bundle.link.organizationId,
          actorUserId: null,
          action: "DOCUMENT_SHARE_LINK_DENIED",
          resourceType: "DOCUMENT",
          resourceId: bundle.link.documentId,
          result: "DENIED",
          requestId,
          ipAddress,
          metadata: {
            shareLinkId: bundle.link.id,
            reason: "DOWNLOAD_DISABLED",
          },
        });
        throw new DomainError(
          "SHARE_DOWNLOAD_FORBIDDEN",
          "Este link permite apenas visualização protegida do documento.",
        );
      }

      const updatedLink = await deps.shareLinks.consumeUseAtomically({
        id: bundle.link.id,
        now: now(),
      });
      if (!updatedLink) {
        throw new DomainError(
          "SHARE_LINK_UNAVAILABLE",
          "Link de compartilhamento indisponível, expirado ou com limite de acessos atingido.",
        );
      }

      await auditWriter.write({
        organizationId: updatedLink.organizationId,
        actorUserId: null,
        action: "DOCUMENT_SHARE_LINK_ACCESSED",
        resourceType: "DOCUMENT",
        resourceId: updatedLink.documentId,
        result: "SUCCESS",
        requestId,
        ipAddress,
        metadata: {
          shareLinkId: updatedLink.id,
          documentVersionId: bundle.version.id,
          delivery,
          useCount: updatedLink.useCount,
        },
      });

      return {
        shareLink: updatedLink,
        organizationId: updatedLink.organizationId,
        documentId: updatedLink.documentId,
        documentTitle: bundle.documentTitle,
        version: bundle.version,
        fileObject: bundle.fileObject,
      };
    },

    async recordAccessDenied({ rawToken, reason, requestId, ipAddress }) {
      const trimmed = rawToken.trim();
      if (trimmed.length < 24 || trimmed.length > 256) {
        return;
      }
      const tokenHash = deps.crypto.hashToken(trimmed);
      const link = await deps.shareLinks.findByTokenHash(tokenHash);
      if (!link) {
        return;
      }
      await auditWriter.write({
        organizationId: link.organizationId,
        actorUserId: null,
        action: "DOCUMENT_SHARE_LINK_DENIED",
        resourceType: "DOCUMENT",
        resourceId: link.documentId,
        result: "DENIED",
        requestId,
        ipAddress,
        metadata: {
          shareLinkId: link.id,
          reason,
        },
      });
    },
  };
}
