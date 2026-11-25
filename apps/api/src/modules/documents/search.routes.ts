import {
  CONTRACTS_API_PREFIX,
  type DocumentSearchQuery,
  documentSearchQuerySchema,
  documentSearchRequestSchema,
} from "@papyrus/contracts";
import type { DocumentSearchFilter, DocumentSearchRepository } from "@papyrus/database";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type DocumentAuthorizationGuard,
  buildDocumentQueryScope,
} from "../../plugins/authorization.js";

function toRepositorySearchFilter(
  organizationId: string,
  input: DocumentSearchQuery,
): DocumentSearchFilter {
  return {
    organizationId,
    search: input.search,
    categoryId: input.categoryId,
    folderId: input.folderId,
    rootOnly: input.rootOnly,
    includeSubfolders: input.includeSubfolders,
    status: input.status,
    authorUserId: input.authorUserId,
    ownerUserId: input.ownerUserId,
    issueDateFrom: input.issueDateFrom,
    issueDateTo: input.issueDateTo,
    expirationFrom: input.expirationFrom,
    expirationTo: input.expirationTo,
    createdFrom: input.createdFrom,
    createdTo: input.createdTo,
    updatedFrom: input.updatedFrom,
    updatedTo: input.updatedTo,
    tagId: input.tagId,
    tagIds: input.tagIds,
    metadataFilters: input.metadataFilters,
    page: input.page,
    pageSize: input.pageSize,
    sortBy: input.sortBy ?? "updatedAt",
    sortDirection: input.sortDirection,
  };
}

/**
 * Registers advanced document search endpoints (`GET` and `POST /api/v1/documents/search`),
 * validating filters, sorting, and scope and applying authorization before counts and pagination.
 */
export async function registerDocumentSearchRoutes(
  app: FastifyInstance,
  deps: {
    readonly guard: DocumentAuthorizationGuard;
    readonly documentSearchRepository: DocumentSearchRepository;
  },
): Promise<void> {
  const { guard, documentSearchRepository } = deps;

  const executeAuthorizedSearch = async (
    request: FastifyRequest,
    reply: FastifyReply,
    input: DocumentSearchQuery,
  ): Promise<FastifyReply> => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    if (input.status === "DELETED") {
      return reply.status(200).send({
        items: [],
        pagination: {
          page: input.page,
          pageSize: input.pageSize,
          totalItems: 0,
          totalPages: 0,
        },
      });
    }

    const scope = buildDocumentQueryScope(ctx.loaded, ctx.rolePermissions, "READ");
    const result = await documentSearchRepository.searchAuthorizedDocuments(
      toRepositorySearchFilter(ctx.me.user.organizationId, input),
      scope,
    );

    return reply.status(200).send({
      items: result.items,
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        totalItems: result.totalItems,
        totalPages: result.totalPages,
      },
    });
  };

  app.get(`${CONTRACTS_API_PREFIX}/documents/search`, async (request, reply) => {
    const parsed = documentSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Parâmetros de pesquisa inválidos.",
          requestId: request.id,
        },
      });
    }

    return executeAuthorizedSearch(request, reply, parsed.data);
  });

  app.post(`${CONTRACTS_API_PREFIX}/documents/search`, async (request, reply) => {
    const parsed = documentSearchRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Critérios de pesquisa inválidos.",
          requestId: request.id,
        },
      });
    }

    return executeAuthorizedSearch(request, reply, parsed.data);
  });
}
