import type { AuthMeResponse } from "@docuflow/contracts";
import { CONTRACTS_API_PREFIX } from "@docuflow/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME } from "../auth/auth.routes.js";
import type { AuthService } from "../auth/auth.service.js";
import { type ApiHealthDependencies, createApiHealthService } from "./health.service.js";

export interface HealthRoutesDependencies {
  readonly healthDeps?: ApiHealthDependencies | undefined;
  readonly authService?: AuthService | undefined;
}

function isOperationalAdmin(me: AuthMeResponse): boolean {
  return (
    me.roles.some((role) => role.key === "admin") ||
    me.permissions.some(
      (perm) =>
        (perm.action === "MANAGE_STORAGE" && perm.resource === "STORAGE") ||
        (perm.action === "VIEW_AUDIT" && perm.resource === "AUDIT"),
    )
  );
}

async function requireOperationalAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
): Promise<AuthMeResponse | null> {
  const rawToken = request.cookies[SESSION_COOKIE_NAME];
  const outcome = await authService.getMe(rawToken);
  if (!outcome) {
    void reply.status(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Sessão não autenticada ou expirada.",
        requestId: request.id,
      },
    });
    return null;
  }

  if (!isOperationalAdmin(outcome.me)) {
    void reply.status(403).send({
      error: {
        code: "FORBIDDEN",
        message: "Você não possui permissão para consultar o status operacional da instalação.",
        requestId: request.id,
      },
    });
    return null;
  }

  return outcome.me;
}

/**
 * Registers public liveness/readiness probes (sanitized, without internal leakage)
 * and authenticated administrative operational status diagnostics.
 */
export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthRoutesDependencies = {},
): Promise<void> {
  const healthService = createApiHealthService(deps.healthDeps);

  app.get(`${CONTRACTS_API_PREFIX}/health/live`, async (_request, reply) => {
    return reply.header("Cache-Control", "no-store").status(200).send({ status: "ok" });
  });

  app.get(`${CONTRACTS_API_PREFIX}/health/ready`, async (request, reply) => {
    const report = await healthService.checkPublicReadiness();
    if (report.status !== "ready") {
      request.log.warn({ checks: report.checks }, "API readiness check failed");
    }

    return reply
      .header("Cache-Control", "no-store")
      .status(report.status === "ready" ? 200 : 503)
      .send({
        status: report.status,
        checkedAt: report.checkedAt,
        checks: report.checks,
      });
  });

  if (deps.authService) {
    const authService = deps.authService;
    app.get(`${CONTRACTS_API_PREFIX}/admin/system-status`, async (request, reply) => {
      const actor = await requireOperationalAdmin(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const status = await healthService.getAdminSystemStatus(actor.user.organizationId);
      return reply.header("Cache-Control", "private, no-store").status(200).send({ data: status });
    });
  }
}
