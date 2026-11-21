import { roleGrantsPermission } from "@docuflow/auth";
import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  attachDocumentTagInputSchema,
  createTagInputSchema,
  tagListQuerySchema,
  uuidSchema,
} from "@docuflow/contracts";
import { type AccessAction, DomainError, type TagService } from "@docuflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AuthenticatedAuthorizationContext,
  DocumentAuthorizationGuard,
} from "../../plugins/authorization.js";

export interface TagRoutesDependencies {
  readonly documentGuard: DocumentAuthorizationGuard;
  readonly tagService: TagService;
}

function mapTagDomainErrorStatus(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "DOCUMENT_NOT_FOUND":
    case "TAG_NOT_FOUND":
    case "DOCUMENT_TAG_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "TAG_ALREADY_EXISTS":
    case "DOCUMENT_TAG_ALREADY_ATTACHED":
      return { status: 409, apiCode: "CONFLICT" };
    case "INVALID_TAG_NAME":
    case "INVALID_CATEGORY_COLOR":
      return { status: 400, apiCode: "VALIDATION_ERROR" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

function handleTagError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    const mapped = mapTagDomainErrorStatus(error.code);
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

function hasAnyNonDeniedDocumentAction(
  ctx: AuthenticatedAuthorizationContext,
  actions: readonly AccessAction[],
): boolean {
  let hasGlobalDeny = false;
  let hasAllow = false;

  for (const assignment of ctx.subject.assignments) {
    const perms = ctx.rolePermissions.get(assignment.roleId);
    if (!perms) {
      continue;
    }
    const grantsRequested = actions.some((action) =>
      roleGrantsPermission(perms, action, "DOCUMENT"),
    );
    if (!grantsRequested) {
      continue;
    }

    if (assignment.scope.type === "GLOBAL" && assignment.effect === "DENY") {
      hasGlobalDeny = true;
    } else if (assignment.effect === "ALLOW") {
      hasAllow = true;
    }
  }

  return !hasGlobalDeny && hasAllow;
}

/**
 * Registers organization tag routes and document-tag association endpoints.
 */
export async function registerTagRoutes(
  app: FastifyInstance,
  deps: TagRoutesDependencies,
): Promise<void> {
  const { documentGuard, tagService } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/tags`, async (request, reply) => {
    const ctx = await documentGuard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    if (!hasAnyNonDeniedDocumentAction(ctx, ["READ"])) {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Você não possui permissão para visualizar etiquetas.",
          requestId: request.id,
        },
      });
    }

    const parsed = tagListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Parâmetros de consulta inválidos para listagem de etiquetas.",
          requestId: request.id,
        },
      });
    }

    const result = await tagService.listTags({
      organizationId: ctx.me.user.organizationId,
      search: parsed.data.search,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      sortBy: parsed.data.sortBy ?? "name",
      sortDirection: parsed.data.sortDirection === "desc" ? "desc" : "asc",
    });

    return reply.status(200).send({
      data: {
        items: result.items,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          totalItems: result.totalItems,
          totalPages: result.totalPages,
        },
      },
    });
  });

  app.post(`${CONTRACTS_API_PREFIX}/tags`, async (request, reply) => {
    const parsed = createTagInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Dados inválidos para criação de etiqueta.",
          requestId: request.id,
        },
      });
    }

    const ctx = await documentGuard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    if (!hasAnyNonDeniedDocumentAction(ctx, ["CREATE", "UPDATE"])) {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Você não possui permissão para criar etiquetas.",
          requestId: request.id,
        },
      });
    }

    try {
      const created = await tagService.createTag({
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        requestId: request.id,
        name: parsed.data.name,
        color: parsed.data.color,
      });
      return reply.status(201).send({ data: created });
    } catch (error) {
      return handleTagError(error, request, reply);
    }
  });

  app.get(`${CONTRACTS_API_PREFIX}/documents/:id/tags`, async (request, reply) => {
    const idParsed = uuidSchema.safeParse((request.params as { readonly id?: unknown }).id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de documento inválido.",
          requestId: request.id,
        },
      });
    }

    const ctx = await documentGuard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const doc = await documentGuard.authorizeDocument(
      ctx,
      idParsed.data,
      "READ",
      reply,
      request.id,
    );
    if (!doc) {
      return reply;
    }

    const items = await tagService.listDocumentTags(ctx.me.user.organizationId, doc.id);
    return reply.status(200).send({ data: items });
  });

  app.post(`${CONTRACTS_API_PREFIX}/documents/:id/tags`, async (request, reply) => {
    const idParsed = uuidSchema.safeParse((request.params as { readonly id?: unknown }).id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de documento inválido.",
          requestId: request.id,
        },
      });
    }

    const bodyParsed = attachDocumentTagInputSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de etiqueta inválido.",
          requestId: request.id,
        },
      });
    }

    const ctx = await documentGuard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const doc = await documentGuard.authorizeDocument(
      ctx,
      idParsed.data,
      "UPDATE",
      reply,
      request.id,
    );
    if (!doc) {
      return reply;
    }

    try {
      const updatedTags = await tagService.attachTagToDocument({
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        requestId: request.id,
        documentId: doc.id,
        tagId: bodyParsed.data.tagId,
      });
      return reply.status(201).send({ data: updatedTags });
    } catch (error) {
      return handleTagError(error, request, reply);
    }
  });

  app.delete(`${CONTRACTS_API_PREFIX}/documents/:id/tags/:tagId`, async (request, reply) => {
    const params = request.params as { readonly id?: unknown; readonly tagId?: unknown };
    const idParsed = uuidSchema.safeParse(params.id);
    const tagIdParsed = uuidSchema.safeParse(params.tagId);
    if (!idParsed.success || !tagIdParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de documento ou etiqueta inválido.",
          requestId: request.id,
        },
      });
    }

    const ctx = await documentGuard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const doc = await documentGuard.authorizeDocument(
      ctx,
      idParsed.data,
      "UPDATE",
      reply,
      request.id,
    );
    if (!doc) {
      return reply;
    }

    try {
      await tagService.detachTagFromDocument({
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        requestId: request.id,
        documentId: doc.id,
        tagId: tagIdParsed.data,
      });
      return reply.status(204).send();
    } catch (error) {
      return handleTagError(error, request, reply);
    }
  });
}
