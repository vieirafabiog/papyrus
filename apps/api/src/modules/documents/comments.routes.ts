import { evaluateDocumentAuthorization } from "@papyrus/auth";
import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  createDocumentCommentRequestSchema,
  documentCommentListQuerySchema,
  mentionCandidateQuerySchema,
  uuidSchema,
} from "@papyrus/contracts";
import type { AuthorizationRepository } from "@papyrus/database";
import {
  type DocumentCommentEntity,
  type DocumentCommentService,
  type DocumentEntity,
  DomainError,
} from "@papyrus/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AuthenticatedAuthorizationContext,
  DocumentAuthorizationGuard,
} from "../../plugins/authorization.js";

export interface DocumentCommentRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly commentService: DocumentCommentService;
  readonly authzRepository?: AuthorizationRepository | undefined;
}

async function canModerateDocumentComments(
  ctx: AuthenticatedAuthorizationContext,
  doc: DocumentEntity,
  authzRepository?: AuthorizationRepository | undefined,
): Promise<boolean> {
  const folderAncestorIds =
    authzRepository && doc.folderId
      ? await authzRepository.loadFolderAncestorIds(ctx.me.user.organizationId, doc.folderId)
      : doc.folderId
        ? [doc.folderId]
        : [];

  const scope = {
    documentId: doc.id,
    categoryId: doc.categoryId,
    folderAncestorIds,
  };

  const canUpdate = evaluateDocumentAuthorization(
    ctx.subject,
    "UPDATE",
    scope,
    ctx.rolePermissions,
  ).allowed;

  if (canUpdate) {
    return true;
  }

  return evaluateDocumentAuthorization(ctx.subject, "DELETE", scope, ctx.rolePermissions).allowed;
}

function serializeComment(
  comment: DocumentCommentEntity,
  actorUserId: string,
  canModerate: boolean,
) {
  return {
    id: comment.id,
    organizationId: comment.organizationId,
    documentId: comment.documentId,
    author: comment.author,
    body: comment.body,
    mentions: [...comment.mentions],
    canDelete: comment.author.id === actorUserId || canModerate,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function mapCommentDomainErrorStatus(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "DOCUMENT_NOT_FOUND":
    case "COMMENT_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "COMMENT_DELETE_FORBIDDEN":
      return { status: 403, apiCode: "FORBIDDEN" };
    case "DOCUMENT_DELETED_COMMENT_FORBIDDEN":
      return { status: 409, apiCode: "CONFLICT" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

function handleCommentError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    const mapped = mapCommentDomainErrorStatus(error.code);
    return reply.status(mapped.status).send({
      error: {
        code: mapped.apiCode,
        message: error.message,
        requestId: request.id,
        details: { domainCode: error.code },
      },
    });
  }
  throw error;
}

function setPrivateNoStoreHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Cookie, Origin");
}

/**
 * Registers document collaboration comment and same-organization @mention endpoints:
 * - `GET /api/v1/documents/:id/mention-candidates`
 * - `GET /api/v1/documents/:id/comments`
 * - `POST /api/v1/documents/:id/comments`
 * - `DELETE /api/v1/documents/:id/comments/:commentId`
 */
export async function registerDocumentCommentRoutes(
  app: FastifyInstance,
  deps: DocumentCommentRoutesDependencies,
): Promise<void> {
  const { guard, commentService, authzRepository } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/documents/:id/mention-candidates`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const params = request.params as { id?: string };
    const idParsed = uuidSchema.safeParse(params.id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de documento inválido.",
          requestId: request.id,
        },
      });
    }

    const doc = await guard.authorizeDocument(
      ctx,
      idParsed.data,
      "READ",
      reply,
      request.id,
      request.ip,
    );
    if (!doc) {
      return reply;
    }

    const queryParsed = mentionCandidateQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            queryParsed.error.issues[0]?.message ?? "Parâmetros inválidos para busca de usuários.",
          requestId: request.id,
        },
      });
    }

    const items = await commentService.listMentionCandidates({
      organizationId: ctx.me.user.organizationId,
      query: queryParsed.data.q,
      limit: queryParsed.data.limit,
    });

    setPrivateNoStoreHeaders(reply);
    return reply.status(200).send({
      data: {
        items,
      },
    });
  });

  app.get(`${CONTRACTS_API_PREFIX}/documents/:id/comments`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const params = request.params as { id?: string };
    const idParsed = uuidSchema.safeParse(params.id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de documento inválido.",
          requestId: request.id,
        },
      });
    }

    const doc = await guard.authorizeDocument(
      ctx,
      idParsed.data,
      "READ",
      reply,
      request.id,
      request.ip,
    );
    if (!doc) {
      return reply;
    }

    const queryParsed = documentCommentListQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            queryParsed.error.issues[0]?.message ??
            "Parâmetros inválidos para listagem de comentários.",
          requestId: request.id,
        },
      });
    }

    const result = await commentService.listComments({
      organizationId: ctx.me.user.organizationId,
      documentId: doc.id,
      page: queryParsed.data.page,
      pageSize: queryParsed.data.pageSize,
    });

    const canModerate = await canModerateDocumentComments(ctx, doc, authzRepository);
    setPrivateNoStoreHeaders(reply);

    return reply.status(200).send({
      data: {
        items: result.items.map((item) => serializeComment(item, ctx.me.user.id, canModerate)),
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          totalItems: result.totalItems,
          totalPages: result.totalPages,
        },
      },
    });
  });

  app.post(`${CONTRACTS_API_PREFIX}/documents/:id/comments`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const params = request.params as { id?: string };
    const idParsed = uuidSchema.safeParse(params.id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de documento inválido.",
          requestId: request.id,
        },
      });
    }

    const doc = await guard.authorizeDocument(
      ctx,
      idParsed.data,
      "READ",
      reply,
      request.id,
      request.ip,
    );
    if (!doc) {
      return reply;
    }

    const bodyParsed = createDocumentCommentRequestSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: bodyParsed.error.issues[0]?.message ?? "Dados inválidos para o comentário.",
          requestId: request.id,
        },
      });
    }

    try {
      const created = await commentService.createComment({
        organizationId: ctx.me.user.organizationId,
        documentId: doc.id,
        actorUserId: ctx.me.user.id,
        actorDisplayName: ctx.me.user.fullName,
        requestId: request.id,
        ipAddress: request.ip,
        body: bodyParsed.data.body,
        mentionedUserIds: bodyParsed.data.mentionedUserIds,
      });

      const canModerate = await canModerateDocumentComments(ctx, doc, authzRepository);
      return reply.status(201).send({
        data: serializeComment(created, ctx.me.user.id, canModerate),
      });
    } catch (error) {
      return handleCommentError(error, request, reply);
    }
  });

  app.delete(
    `${CONTRACTS_API_PREFIX}/documents/:id/comments/:commentId`,
    async (request, reply) => {
      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const params = request.params as { id?: string; commentId?: string };
      const docIdParsed = uuidSchema.safeParse(params.id);
      const commentIdParsed = uuidSchema.safeParse(params.commentId);
      if (!docIdParsed.success || !commentIdParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificadores de documento ou comentário inválidos.",
            requestId: request.id,
          },
        });
      }

      const doc = await guard.authorizeDocument(
        ctx,
        docIdParsed.data,
        "READ",
        reply,
        request.id,
        request.ip,
      );
      if (!doc) {
        return reply;
      }

      const canModerateComments = await canModerateDocumentComments(ctx, doc, authzRepository);

      try {
        const result = await commentService.deleteComment({
          organizationId: ctx.me.user.organizationId,
          documentId: doc.id,
          commentId: commentIdParsed.data,
          actorUserId: ctx.me.user.id,
          canModerateComments,
          requestId: request.id,
          ipAddress: request.ip,
        });

        return reply.status(200).send({
          data: {
            deleted: true as const,
            commentId: result.commentId,
          },
        });
      } catch (error) {
        return handleCommentError(error, request, reply);
      }
    },
  );
}
