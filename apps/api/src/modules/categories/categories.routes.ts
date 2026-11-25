import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  categoryListQuerySchema,
  createCategoryFieldInputSchema,
  createCategoryInputSchema,
  deleteCategoryFieldInputSchema,
  updateCategoryFieldInputSchema,
  updateCategoryInputSchema,
  uuidSchema,
} from "@papyrus/contracts";
import { type CategoryFieldService, type CategoryService, DomainError } from "@papyrus/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type CategoryAuthorizationGuard,
  buildCategoryQueryScope,
  buildRolePermissionsLookup,
} from "../../plugins/authorization.js";

export interface CategoryRoutesDependencies {
  readonly guard: CategoryAuthorizationGuard;
  readonly categoryService: CategoryService;
  readonly categoryFieldService: CategoryFieldService;
}

function mapCategoryDomainErrorStatus(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "CATEGORY_NOT_FOUND":
    case "CATEGORY_FIELD_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "CATEGORY_NAME_ALREADY_IN_USE":
    case "CATEGORY_HAS_EXISTING_DOCUMENTS":
    case "CATEGORY_FIELD_KEY_ALREADY_IN_USE":
    case "INCOMPATIBLE_CATEGORY_FIELD_CHANGE":
      return { status: 409, apiCode: "CONFLICT" };
    case "INVALID_CATEGORY_NAME":
    case "INVALID_CATEGORY_DESCRIPTION":
    case "INVALID_CATEGORY_COLOR":
    case "INVALID_CATEGORY_ICON":
    case "INVALID_CATEGORY_FIELD":
    case "INVALID_FIELD_MIGRATION":
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
 * Registers category CRUD and typed custom-field management routes.
 */
export async function registerCategoryRoutes(
  app: FastifyInstance,
  deps: CategoryRoutesDependencies,
): Promise<void> {
  const { guard, categoryService, categoryFieldService } = deps;

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
        textIndexingMode: parsed.data.textIndexingMode,
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

    const fields = await categoryFieldService.listFields(
      authorized.subject.me.user.organizationId,
      authorized.category.id,
    );
    return reply.status(200).send({ data: { ...authorized.category, fields } });
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
      bodyParsed.data.isActive === undefined &&
      bodyParsed.data.textIndexingMode === undefined
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
        textIndexingMode: bodyParsed.data.textIndexingMode,
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

  app.get(`${CONTRACTS_API_PREFIX}/categories/:id/fields`, async (request, reply) => {
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

    const fields = await categoryFieldService.listFields(
      authorized.subject.me.user.organizationId,
      authorized.category.id,
    );
    return reply.status(200).send({ data: fields });
  });

  app.post(`${CONTRACTS_API_PREFIX}/categories/:id/fields`, async (request, reply) => {
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

    const bodyParsed = createCategoryFieldInputSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: bodyParsed.error.issues[0]?.message ?? "Dados inválidos para criação de campo.",
          requestId: request.id,
        },
      });
    }

    const authorized = await guard.authorizeCategory(request, reply, "UPDATE", idParsed.data);
    if (!authorized) {
      return reply;
    }

    try {
      const created = await categoryFieldService.addField({
        organizationId: authorized.subject.me.user.organizationId,
        actorUserId: authorized.subject.me.user.id,
        requestId: request.id,
        categoryId: authorized.category.id,
        key: bodyParsed.data.key,
        label: bodyParsed.data.label,
        type: bodyParsed.data.type,
        required: bodyParsed.data.required,
        options: bodyParsed.data.options,
        sortOrder: bodyParsed.data.sortOrder,
        migrationStrategy: bodyParsed.data.migrationStrategy,
      });
      return reply.status(201).send({ data: created });
    } catch (error) {
      return handleCategoryError(error, request, reply);
    }
  });

  app.patch(`${CONTRACTS_API_PREFIX}/categories/:id/fields/:fieldId`, async (request, reply) => {
    const params = request.params as { readonly id?: unknown; readonly fieldId?: unknown };
    const idParsed = uuidSchema.safeParse(params.id);
    const fieldIdParsed = uuidSchema.safeParse(params.fieldId);
    if (!idParsed.success || !fieldIdParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de categoria ou campo inválido.",
          requestId: request.id,
        },
      });
    }

    const bodyParsed = updateCategoryFieldInputSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            bodyParsed.error.issues[0]?.message ?? "Dados inválidos para atualização do campo.",
          requestId: request.id,
        },
      });
    }

    if (
      bodyParsed.data.label === undefined &&
      bodyParsed.data.type === undefined &&
      bodyParsed.data.required === undefined &&
      bodyParsed.data.options === undefined &&
      bodyParsed.data.sortOrder === undefined
    ) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Informe ao menos um campo de configuração para atualizar.",
          requestId: request.id,
        },
      });
    }

    const authorized = await guard.authorizeCategory(request, reply, "UPDATE", idParsed.data);
    if (!authorized) {
      return reply;
    }

    try {
      const updated = await categoryFieldService.updateField({
        organizationId: authorized.subject.me.user.organizationId,
        actorUserId: authorized.subject.me.user.id,
        requestId: request.id,
        categoryId: authorized.category.id,
        fieldId: fieldIdParsed.data,
        label: bodyParsed.data.label,
        type: bodyParsed.data.type,
        required: bodyParsed.data.required,
        options: bodyParsed.data.options,
        sortOrder: bodyParsed.data.sortOrder,
        migrationStrategy: bodyParsed.data.migrationStrategy,
      });
      return reply.status(200).send({ data: updated });
    } catch (error) {
      return handleCategoryError(error, request, reply);
    }
  });

  app.delete(`${CONTRACTS_API_PREFIX}/categories/:id/fields/:fieldId`, async (request, reply) => {
    const params = request.params as { readonly id?: unknown; readonly fieldId?: unknown };
    const idParsed = uuidSchema.safeParse(params.id);
    const fieldIdParsed = uuidSchema.safeParse(params.fieldId);
    if (!idParsed.success || !fieldIdParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de categoria ou campo inválido.",
          requestId: request.id,
        },
      });
    }

    const rawBody = request.body === undefined || request.body === null ? {} : request.body;
    const bodyParsed = deleteCategoryFieldInputSchema.safeParse(rawBody);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Estratégia de migração inválida para remoção do campo.",
          requestId: request.id,
        },
      });
    }

    const authorized = await guard.authorizeCategory(request, reply, "UPDATE", idParsed.data);
    if (!authorized) {
      return reply;
    }

    try {
      await categoryFieldService.removeField({
        organizationId: authorized.subject.me.user.organizationId,
        actorUserId: authorized.subject.me.user.id,
        requestId: request.id,
        categoryId: authorized.category.id,
        fieldId: fieldIdParsed.data,
        migrationStrategy: bodyParsed.data.migrationStrategy,
      });
      return reply.status(204).send();
    } catch (error) {
      return handleCategoryError(error, request, reply);
    }
  });
}
