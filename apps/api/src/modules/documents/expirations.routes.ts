import { CONTRACTS_API_PREFIX, documentExpirationsQuerySchema } from "@papyrus/contracts";
import type { DocumentExpirationRepository } from "@papyrus/database";
import type { FastifyInstance } from "fastify";
import {
  type DocumentAuthorizationGuard,
  buildDocumentQueryScope,
} from "../../plugins/authorization.js";

export interface DocumentExpirationsRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly documentExpirationRepository: DocumentExpirationRepository;
  readonly now?: (() => Date) | undefined;
}

/**
 * Registers `GET /api/v1/documents/expirations` returning timezone-aware,
 * permission-scoped overdue, expiring-soon, up-to-date, and undated document listings.
 */
export async function registerDocumentExpirationRoutes(
  app: FastifyInstance,
  deps: DocumentExpirationsRoutesDependencies,
): Promise<void> {
  const { guard, documentExpirationRepository, now } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/documents/expirations`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const parsed = documentExpirationsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            parsed.error.issues[0]?.message ?? "Parâmetros inválidos para consulta de vencimentos.",
          requestId: request.id,
        },
      });
    }

    const q = parsed.data;
    const scope = buildDocumentQueryScope(ctx.loaded, ctx.rolePermissions, "READ");
    const result = await documentExpirationRepository.listAuthorizedExpirations(
      {
        organizationId: ctx.me.user.organizationId,
        bucket: q.bucket,
        windowDays: q.windowDays,
        timezone: q.timezone,
        categoryId: q.categoryId,
        folderId: q.folderId,
        ownerUserId: q.ownerUserId,
        search: q.search,
        includeArchived: q.includeArchived,
        page: q.page,
        pageSize: q.pageSize,
        sortBy: q.sortBy,
        sortDirection: q.sortDirection,
        referenceNow: now ? now() : new Date(),
      },
      scope,
    );

    reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
    reply.header("Pragma", "no-cache");
    reply.header("Vary", "Cookie, Origin");

    return reply.status(200).send({
      data: {
        items: result.list.items,
        pagination: {
          page: result.list.page,
          pageSize: result.list.pageSize,
          totalItems: result.list.totalItems,
          totalPages: result.list.totalPages,
        },
        summary: result.summary,
        timezone: result.timezone,
        referenceDate: result.referenceDate,
        windowDays: result.windowDays,
      },
    });
  });
}
