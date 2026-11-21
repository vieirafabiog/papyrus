import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  categoryListQuerySchema,
  createCategoryInputSchema,
  updateCategoryInputSchema,
  uuidSchema,
} from "@docuflow/contracts";
import { type CategoryService, DomainError } from "@docuflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type CategoryAuthorizationGuard,
  buildCategoryQueryScope,
  buildRolePermissionsLookup,
} from "../../plugins/authorization.js";

export interface CategoryRoutesDependencies {
  readonly guard: CategoryAuthorizationGuard;
  readonly categoryService: CategoryService;
}

function mapCategoryDomainErrorStatus(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "CATEGORY_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "CATEGORY_NAME_ALREADY_IN_USE":
    case "CATEGORY_HAS_EXISTING_DOCUMENTS":
      return { status: 409, apiCode: "CONFLICT" };
    case "INVALID_CATEGORY_NAME":
    case "INVALID_CATEGORY_DESCRIPTION":
    case "INVALID_CATEGORY_COLOR":
    case "INVALID_CATEGORY_ICON":
      return { status: 400, apiCode: "VALIDATION_ERROR" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

function handleCategoryError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    const mapped = mapCategoryDomainErrorStatus(error.code);
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
 * Registers category CRUD routes enforcing server-side authorization and document-link validation.
 */
export async function registerCategoryRoutes(
  app: FastifyInstance,
  deps: CategoryRoutesDependencies,
): Promise<void> {
  const { guard, categoryService } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/categories`, async (request, reply) => {
    const subject = await guard.requireSubject(request, reply);
    if (!subject) {
      return reply;
    }

    const parsed = categoryListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Parâmetros de consulta inválidos para listagem de categorias.",
          requestId: request.id,
        },
      });
    }

    const rolePermissions = buildRolePermissionsLookup(subject.loaded);
    const scope = buildCategoryQueryScope(subject.loaded, rolePermissions, "READ");

    const result = await categoryService.listAuthorizedCategories(
      {
        organizationId: subject.me.user.organizationId,
        isActive: parsed.data.isActive,
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

  app.post(`${CONTRACTS_API_PREFIX}/categories`, async (request, reply) => {
    const parsed = createCategoryInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Dados inválidos para criação da categoria.",
          requestId: request.id,
        },
      });
    }

    const subject = await guard.authorizeCreateScope(request, reply);
    if (!subject) {
      return reply;
    }

    try {
      const created = await categoryService.createCategory({
        organizationId: subject.me.user.organizationId,
        actorUserId: subject.me.user.id,
        requestId: request.id,
        name: parsed.data.name,
        description: parsed.data.description,
        color: parsed.data.color,
        icon: parsed.data.icon,
      });
      return reply.status(201).send({ data: created });
    } catch (error) {
      return handleCategoryError(error, request, reply);
    }
  });

  app.get(`${CONTRACTS_API_PREFIX}/categories/:id`, async (request, reply) => {
    const idParsed = uuidSchema.safeParse((request.params as { readonly id?: unknown }).id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de categoria inválido.",
          requestId: request.id,
        },
      });
    }

    const authorized = await guard.authorizeCategory(request, reply, "READ", idParsed.data);
    if (!authorized) {
      return reply;
    }

    return reply.status(200).send({ data: authorized.category });
  });

  app.patch(`${CONTRACTS_API_PREFIX}/categories/:id`, async (request, reply) => {
    const idParsed = uuidSchema.safeParse((request.params as { readonly id?: unknown }).id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de categoria inválido.",
          requestId: request.id,
        },
      });
    }

    const bodyParsed = updateCategoryInputSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            bodyParsed.error.issues[0]?.message ?? "Dados inválidos para atualização da categoria.",
          requestId: request.id,
        },
      });
    }

    if (
      bodyParsed.data.name === undefined &&
      bodyParsed.data.description === undefined &&
      bodyParsed.data.color === undefined &&
      bodyParsed.data.icon === undefined &&
      bodyParsed.data.isActive === undefined
    ) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Informe ao menos um campo para atualização da categoria.",
          requestId: request.id,
        },
      });
    }

    const authorized = await guard.authorizeCategory(request, reply, "UPDATE", idParsed.data);
    if (!authorized) {
      return reply;
    }

    try {
      const updated = await categoryService.updateCategory({
        organizationId: authorized.subject.me.user.organizationId,
        actorUserId: authorized.subject.me.user.id,
        requestId: request.id,
        categoryId: authorized.category.id,
        name: bodyParsed.data.name,
        description: bodyParsed.data.description,
        color: bodyParsed.data.color,
        icon: bodyParsed.data.icon,
        isActive: bodyParsed.data.isActive,
      });
      return reply.status(200).send({ data: updated });
    } catch (error) {
      return handleCategoryError(error, request, reply);
    }
  });

  app.post(`${CONTRACTS_API_PREFIX}/categories/:id/deactivate`, async (request, reply) => {
    const idParsed = uuidSchema.safeParse((request.params as { readonly id?: unknown }).id);
    if (!idParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de categoria inválido.",
          requestId: request.id,
        },
      });
    }

    const authorized = await guard.authorizeCategory(request, reply, "DELETE", idParsed.data);
    if (!authorized) {
      return reply;
    }

    try {
      const deactivated = await categoryService.deactivateCategory({
        organizationId: authorized.subject.me.user.organizationId,
        actorUserId: authorized.subject.me.user.id,
        requestId: request.id,
        categoryId: authorized.category.id,
      });
      return reply.status(200).send({ data: deactivated });
    } catch (error) {
      return handleCategoryError(error, request, reply);
    }
  });
}
