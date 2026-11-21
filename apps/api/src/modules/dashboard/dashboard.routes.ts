import { evaluateAuthorization } from "@docuflow/auth";
import { CONTRACTS_API_PREFIX } from "@docuflow/contracts";
import type { DashboardRepository } from "@docuflow/database";
import type { FastifyInstance } from "fastify";
import {
  type DocumentAuthorizationGuard,
  buildDocumentQueryScope,
} from "../../plugins/authorization.js";

export interface DashboardRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly dashboardRepository: DashboardRepository;
  readonly now?: (() => Date) | undefined;
}

/**
 * Registers `GET /api/v1/dashboard/summary` returning real PostgreSQL aggregations
 * strictly scoped to the authenticated user's document, task, storage, and audit access.
 */
export async function registerDashboardRoutes(
  app: FastifyInstance,
  deps: DashboardRoutesDependencies,
): Promise<void> {
  const { guard, dashboardRepository, now } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/dashboard/summary`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const canViewGlobalAudit = evaluateAuthorization(
      ctx.subject,
      { action: "VIEW_AUDIT", resource: "AUDIT", scope: { type: "GLOBAL" } },
      ctx.rolePermissions,
    ).allowed;

    const activeAllowRoleIds = Array.from(
      new Set(
        ctx.loaded.assignments
          .filter((assignment) => assignment.effect === "ALLOW")
          .map((assignment) => assignment.roleId),
      ),
    );

    const summary = await dashboardRepository.getAuthorizedSummary({
      organizationId: ctx.me.user.organizationId,
      userId: ctx.me.user.id,
      groupIds: ctx.loaded.groupIds,
      roleIds: activeAllowRoleIds,
      scope: buildDocumentQueryScope(ctx.loaded, ctx.rolePermissions, "READ"),
      canViewGlobalAudit,
      referenceDate: now ? now() : new Date(),
    });

    reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
    reply.header("Pragma", "no-cache");
    reply.header("Vary", "Cookie, Origin");

    return reply.status(200).send({
      data: summary,
    });
  });
}
