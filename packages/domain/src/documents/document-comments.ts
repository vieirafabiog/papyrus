import { createAuditWriter } from "../audit/audit-writer.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { DocumentRepositoryPort, PaginatedResult } from "../ports/document-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";

export const MAX_DOCUMENT_COMMENT_BODY_LENGTH = 2000;
export const MAX_DOCUMENT_COMMENT_MENTION_IDS = 20;

export interface DocumentCommentParticipantEntity {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
}

export interface DocumentCommentMentionEntity {
  readonly userId: string;
  readonly fullName: string;
  readonly email: string;
}

export interface DocumentCommentEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly author: DocumentCommentParticipantEntity;
  readonly body: string;
  readonly mentions: readonly DocumentCommentMentionEntity[];
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateDocumentCommentRecordInput {
  readonly id: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly mentionedUserIds: readonly string[];
  readonly createdAt: Date;
}

export interface DocumentCommentRepositoryPort {
  listByDocument(
    input: {
      readonly organizationId: string;
      readonly documentId: string;
      readonly page: number;
      readonly pageSize: number;
    },
    tx?: TransactionContext,
  ): Promise<PaginatedResult<DocumentCommentEntity>>;
  findById(id: string, tx?: TransactionContext): Promise<DocumentCommentEntity | null>;
  create(
    input: CreateDocumentCommentRecordInput,
    tx?: TransactionContext,
  ): Promise<DocumentCommentEntity>;
  softDelete(
    input: {
      readonly id: string;
      readonly deletedAt: Date;
    },
    tx?: TransactionContext,
  ): Promise<boolean>;
  filterActiveOrganizationUsers(
    input: {
      readonly organizationId: string;
      readonly userIds: readonly string[];
    },
    tx?: TransactionContext,
  ): Promise<readonly DocumentCommentParticipantEntity[]>;
  listActiveMentionCandidates(
    input: {
      readonly organizationId: string;
      readonly query?: string | undefined;
      readonly limit: number;
    },
    tx?: TransactionContext,
  ): Promise<readonly DocumentCommentParticipantEntity[]>;
}

export interface DocumentCommentMentionNotifierPort {
  notifyCommentMention(input: {
    readonly organizationId: string;
    readonly recipientUserIds: readonly string[];
    readonly authorUserId: string;
    readonly authorDisplayName: string;
    readonly documentId: string;
    readonly documentTitle: string;
    readonly commentId: string;
    readonly commentExcerpt: string;
    readonly tx?: unknown;
  }): Promise<unknown>;
}

export interface DocumentCommentServiceDependencies {
  readonly comments: DocumentCommentRepositoryPort;
  readonly documents: DocumentRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly mentionNotifier?: DocumentCommentMentionNotifierPort | undefined;
  readonly generateId: () => string;
  readonly now?: (() => Date) | undefined;
}

export interface CreateDocumentCommentCommand {
  readonly organizationId: string;
  readonly documentId: string;
  readonly actorUserId: string;
  readonly actorDisplayName: string;
  readonly requestId: string;
  readonly ipAddress?: string | undefined;
  readonly body: string;
  readonly mentionedUserIds: readonly string[];
}

export interface DeleteDocumentCommentCommand {
  readonly organizationId: string;
  readonly documentId: string;
  readonly commentId: string;
  readonly actorUserId: string;
  readonly canModerateComments: boolean;
  readonly requestId: string;
  readonly ipAddress?: string | undefined;
}

export interface DocumentCommentService {
  listComments(input: {
    readonly organizationId: string;
    readonly documentId: string;
    readonly page: number;
    readonly pageSize: number;
  }): Promise<PaginatedResult<DocumentCommentEntity>>;
  listMentionCandidates(input: {
    readonly organizationId: string;
    readonly query?: string | undefined;
    readonly limit: number;
  }): Promise<readonly DocumentCommentParticipantEntity[]>;
  createComment(command: CreateDocumentCommentCommand): Promise<DocumentCommentEntity>;
  deleteComment(command: DeleteDocumentCommentCommand): Promise<{ readonly commentId: string }>;
}

function normalizeUniqueIds(ids: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const raw of ids) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
    if (unique.size >= MAX_DOCUMENT_COMMENT_MENTION_IDS) {
      break;
    }
  }
  return Array.from(unique);
}

/**
 * Manages document collaboration comments, same-organization @mention resolution,
 * in-app mention notifications, soft deletion, and immutable audit trails.
 */
export function createDocumentCommentService(
  deps: DocumentCommentServiceDependencies,
): DocumentCommentService {
  const now = deps.now ?? (() => new Date());
  const auditWriter = createAuditWriter({ repository: deps.audit });

  return {
    async listComments(input) {
      return deps.comments.listByDocument({
        organizationId: input.organizationId,
        documentId: input.documentId,
        page: input.page,
        pageSize: input.pageSize,
      });
    },

    async listMentionCandidates(input) {
      return deps.comments.listActiveMentionCandidates({
        organizationId: input.organizationId,
        query: input.query,
        limit: input.limit,
      });
    },

    async createComment(command: CreateDocumentCommentCommand): Promise<DocumentCommentEntity> {
      const normalizedBody = command.body.trim();
      if (normalizedBody.length === 0) {
        throw new DomainError("COMMENT_EMPTY", "Digite um comentário antes de enviar.");
      }
      if (normalizedBody.length > MAX_DOCUMENT_COMMENT_BODY_LENGTH) {
        throw new DomainError(
          "COMMENT_TOO_LONG",
          `O comentário deve ter no máximo ${MAX_DOCUMENT_COMMENT_BODY_LENGTH} caracteres.`,
        );
      }

      const requestedMentionIds = normalizeUniqueIds(command.mentionedUserIds);

      return deps.transactions.runInTransaction(async (tx) => {
        const doc = await deps.documents.findById(command.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }

        if (doc.status === "DELETED") {
          throw new DomainError(
            "DOCUMENT_DELETED_COMMENT_FORBIDDEN",
            "Não é possível comentar em documentos que estão na lixeira.",
          );
        }

        const activeMentionUsers =
          requestedMentionIds.length > 0
            ? await deps.comments.filterActiveOrganizationUsers(
                {
                  organizationId: command.organizationId,
                  userIds: requestedMentionIds,
                },
                tx,
              )
            : [];

        const validatedMentionIds = activeMentionUsers.map((user) => user.id);
        const createdAt = now();
        const commentId = deps.generateId();

        const created = await deps.comments.create(
          {
            id: commentId,
            organizationId: command.organizationId,
            documentId: doc.id,
            authorUserId: command.actorUserId,
            body: normalizedBody,
            mentionedUserIds: validatedMentionIds,
            createdAt,
          },
          tx,
        );

        const recipientUserIds = validatedMentionIds.filter((id) => id !== command.actorUserId);
        if (recipientUserIds.length > 0 && deps.mentionNotifier) {
          await deps.mentionNotifier.notifyCommentMention({
            organizationId: command.organizationId,
            recipientUserIds,
            authorUserId: command.actorUserId,
            authorDisplayName: command.actorDisplayName,
            documentId: doc.id,
            documentTitle: doc.title,
            commentId: created.id,
            commentExcerpt: normalizedBody,
            tx,
          });
        }

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "DOCUMENT_COMMENT_CREATED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: command.requestId,
            ipAddress: command.ipAddress,
            metadata: {
              commentId: created.id,
              mentionCount: validatedMentionIds.length,
            },
          },
          tx,
        );

        return created;
      });
    },

    async deleteComment(
      command: DeleteDocumentCommentCommand,
    ): Promise<{ readonly commentId: string }> {
      return deps.transactions.runInTransaction(async (tx) => {
        const doc = await deps.documents.findById(command.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }

        const existing = await deps.comments.findById(command.commentId, tx);
        if (
          !existing ||
          existing.organizationId !== command.organizationId ||
          existing.documentId !== doc.id ||
          existing.deletedAt !== null
        ) {
          throw new DomainError("COMMENT_NOT_FOUND", "Comentário não encontrado.");
        }

        const isAuthor = existing.author.id === command.actorUserId;
        if (!isAuthor && !command.canModerateComments) {
          throw new DomainError(
            "COMMENT_DELETE_FORBIDDEN",
            "Você não possui permissão para excluir este comentário.",
          );
        }

        await deps.comments.softDelete(
          {
            id: existing.id,
            deletedAt: now(),
          },
          tx,
        );

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "DOCUMENT_COMMENT_DELETED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: command.requestId,
            ipAddress: command.ipAddress,
            metadata: {
              commentId: existing.id,
              deletedByAuthor: isAuthor,
            },
          },
          tx,
        );

        return { commentId: existing.id };
      });
    },
  };
}
