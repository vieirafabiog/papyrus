import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  createFolderRequestSchema,
  folderListQuerySchema,
  moveFolderRequestSchema,
  renameFolderRequestSchema,
  uuidSchema,
} from "@papyrus/contracts";
import { DomainError, type FolderService } from "@papyrus/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type FolderAuthorizationGuard,
  buildFolderQueryScope,
  buildRolePermissionsLookup,
} from "../../plugins/authorization.js";

export interface FolderRoutesDependencies {
  readonly guard: FolderAuthorizationGuard;
  readonly folderService: FolderService;
}

function mapFolderDomainErrorStatus(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "FOLDER_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "FOLDER_NAME_ALREADY_IN_USE":
    case "FOLDER_HIERARCHY_CYCLE":
    case "FOLDER_HAS_ACTIVE_CHILDREN":
    case "FOLDER_ARCHIVED":
      return { status: 409, apiCode: "CONFLICT" };
    case "INVALID_FOLDER_NAME":
      return { status: 400, apiCode: "VALIDATION_ERROR" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

function handleFolderError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    const mapped = mapFolderDomainErrorStatus(error.code);
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

/**
 * Registers hierarchical folder CRUD routes with inherited folder authorization checks.
 */
export async function registerFolderRoutes(
  app: FastifyInstance,
  deps: FolderRoutesDependencies,
): Promise<void> {
  const { guard, folderService } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/folders`, async (request, reply) => {
    const subject = await guard.requireSubject(request, reply);
    if (!subject) {
      return reply;
    }

    const parsed = folderListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Parâmetros de consulta inválidos para listagem de pastas.",
          requestId: request.id,
        },
      });
    }

    if (parsed.data.rootOnly && parsed.data.parentId !== undefined) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Não combine os filtros rootOnly e parentId simultaneamente.",
          requestId: request.id,
        },
      });
    }

    const rolePermissions = buildRolePermissionsLookup(subject.loaded);
    const scope = buildFolderQueryScope(subject.loaded, rolePermissions, "READ");
    const parentFilter = parsed.data.rootOnly ? null : parsed.data.parentId;

    const result = await folderService.listAuthorizedFolders(
      {
        organizationId: subject.me.user.organizationId,
        parentId: parentFilter,
        status: parsed.data.status,
        search: parsed.data.search,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        sortBy: parsed.data.sortBy ?? "name",
        sortDirection: parsed.data.sortDirection === "desc" ? "desc" : "asc",
      },
      scope,
    );

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

  app.post(`${CONTRACTS_API_PREFIX}/folders`, async (request, reply) => {
    const parsed = createFolderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Dados inválidos para criação de pasta.",
          requestId: request.id,
        },
      });
    }

    const parentId = parsed.data.parentId ?? null;
    const subject = await guard.authorizeCreateScope(request, reply, parentId);
    if (!subject) {
      return reply;
    }

    try {
      const created = await folderService.createFolder({
        organizationId: subject.me.user.organizationId,
        actorUserId: subject.me.user.id,
        requestId: request.id,
        parentId,
        name: parsed.data.name,
      });
      return reply.status(201).send({ data: created });
    } catch (error) {
      return handleFolderError(error, request, reply);
    }
  });

  app.get(`${CONTRACTS_API_PREFIX}/folders/:id`, async (request, reply) => {
    const idParsed = uuidSchema.safeParse((request.params as { readonly id?: unknown }).id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de pasta inválido.",
          requestId: request.id,
        },
      });
    }

    const authorized = await guard.authorizeFolder(request, reply, "READ", idParsed.data);
    if (!authorized) {
      return reply;
    }

    return reply.status(200).send({ data: authorized.folder });
  });

  app.patch(`${CONTRACTS_API_PREFIX}/folders/:id`, async (request, reply) => {
    const idParsed = uuidSchema.safeParse((request.params as { readonly id?: unknown }).id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de pasta inválido.",
          requestId: request.id,
        },
      });
    }

    const bodyParsed = renameFolderRequestSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            bodyParsed.error.issues[0]?.message ?? "Dados inválidos para renomeação de pasta.",
          requestId: request.id,
        },
      });
    }

    const authorized = await guard.authorizeFolder(request, reply, "UPDATE", idParsed.data);
    if (!authorized) {
      return reply;
    }

    try {
      const updated = await folderService.renameFolder({
        organizationId: authorized.subject.me.user.organizationId,
        actorUserId: authorized.subject.me.user.id,
        requestId: request.id,
        folderId: authorized.folder.id,
        name: bodyParsed.data.name,
      });
      return reply.status(200).send({ data: updated });
    } catch (error) {
      return handleFolderError(error, request, reply);
    }
  });

  app.post(`${CONTRACTS_API_PREFIX}/folders/:id/move`, async (request, reply) => {
    const idParsed = uuidSchema.safeParse((request.params as { readonly id?: unknown }).id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de pasta inválido.",
          requestId: request.id,
        },
      });
    }

    const bodyParsed = moveFolderRequestSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Dados inválidos para movimentação de pasta.",
          requestId: request.id,
        },
      });
    }

    const authorized = await guard.authorizeFolder(request, reply, "UPDATE", idParsed.data);
    if (!authorized) {
      return reply;
    }

    const destinationAllowed = await guard.authorizeDestinationScope(
      request,
      reply,
      authorized.subject,
      bodyParsed.data.targetParentId,
    );
    if (!destinationAllowed) {
      return reply;
    }

    try {
      const moved = await folderService.moveFolder({
        organizationId: authorized.subject.me.user.organizationId,
        actorUserId: authorized.subject.me.user.id,
        requestId: request.id,
        folderId: authorized.folder.id,
        targetParentId: bodyParsed.data.targetParentId,
      });
      return reply.status(200).send({ data: moved });
    } catch (error) {
      return handleFolderError(error, request, reply);
    }
  });

  app.post(`${CONTRACTS_API_PREFIX}/folders/:id/archive`, async (request, reply) => {
    const idParsed = uuidSchema.safeParse((request.params as { readonly id?: unknown }).id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de pasta inválido.",
          requestId: request.id,
        },
      });
    }

    const authorized = await guard.authorizeFolder(request, reply, "DELETE", idParsed.data);
    if (!authorized) {
      return reply;
    }

    try {
      const archived = await folderService.archiveFolder({
        organizationId: authorized.subject.me.user.organizationId,
        actorUserId: authorized.subject.me.user.id,
        requestId: request.id,
        folderId: authorized.folder.id,
      });
      return reply.status(200).send({ data: archived });
    } catch (error) {
      return handleFolderError(error, request, reply);
    }
  });
}
