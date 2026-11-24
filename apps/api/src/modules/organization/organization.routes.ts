import { evaluateAuthorization } from "@papyrus/auth";
import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  updateOrganizationSettingsRequestSchema,
} from "@papyrus/contracts";
import type { AuthorizationRepository } from "@papyrus/database";
import { DomainError, type OrganizationService } from "@papyrus/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildRolePermissionsLookup, toSubjectContext } from "../../plugins/authorization.js";
import { SESSION_COOKIE_NAME } from "../auth/auth.routes.js";
import type { AuthService } from "../auth/auth.service.js";

export interface OrganizationRoutesDependencies {
  readonly authService: AuthService;
  readonly authzRepository: AuthorizationRepository;
  readonly organizationService: OrganizationService;
}

function mapOrganizationDomainError(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "ORGANIZATION_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

function handleOrganizationDomainError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    const mapped = mapOrganizationDomainError(error.code);
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

async function authorizeOrganizationAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  authzRepository: AuthorizationRepository,
  requiredAction: "READ" | "UPDATE",
): Promise<{
  readonly organizationId: string;
  readonly userId: string;
  readonly canEdit: boolean;
} | null> {
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

  const loaded = await authzRepository.loadSubject(
    outcome.me.user.organizationId,
    outcome.me.user.id,
  );
  const subject = toSubjectContext(loaded);
  const rolePermissions = buildRolePermissionsLookup(loaded);

  const canRead = evaluateAuthorization(
    subject,
    { action: "READ", resource: "ORGANIZATION", scope: { type: "GLOBAL" } },
    rolePermissions,
  ).allowed;

  const canUpdate = evaluateAuthorization(
    subject,
    { action: "UPDATE", resource: "ORGANIZATION", scope: { type: "GLOBAL" } },
    rolePermissions,
  ).allowed;

  const permitted = requiredAction === "READ" ? canRead || canUpdate : canUpdate;
  if (!permitted) {
    void reply.status(403).send({
      error: {
        code: "FORBIDDEN",
        message:
          requiredAction === "UPDATE"
            ? "Você não possui permissão para alterar as configurações da organização."
            : "Você não possui permissão para visualizar as configurações da organização.",
        requestId: request.id,
      },
    });
    return null;
  }

  return {
    organizationId: outcome.me.user.organizationId,
    userId: outcome.me.user.id,
    canEdit: canUpdate,
  };
}

/**
 * Registers HTTP endpoints for reading and updating installation organization identity,
 * language, IANA timezone, and strictly allowlisted installation preferences.
 */
export async function registerOrganizationRoutes(
  app: FastifyInstance,
  deps: OrganizationRoutesDependencies,
): Promise<void> {
  const { authService, authzRepository, organizationService } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/organization`, async (request, reply) => {
    const actor = await authorizeOrganizationAccess(
      request,
      reply,
      authService,
      authzRepository,
      "READ",
    );
    if (!actor) {
      return reply;
    }

    try {
      const organization = await organizationService.getOrganization(actor.organizationId);
      return reply.status(200).send({
        data: {
          organization,
          canEdit: actor.canEdit,
        },
      });
    } catch (error) {
      return handleOrganizationDomainError(error, request, reply);
    }
  });

  app.patch(`${CONTRACTS_API_PREFIX}/organization`, async (request, reply) => {
    const actor = await authorizeOrganizationAccess(
      request,
      reply,
      authService,
      authzRepository,
      "UPDATE",
    );
    if (!actor) {
      return reply;
    }

    const parsed = updateOrganizationSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            parsed.error.issues[0]?.message ??
            "Dados inválidos para atualização das configurações da organização.",
          requestId: request.id,
        },
      });
    }

    try {
      const updated = await organizationService.updateOrganization({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: request.id,
        name: parsed.data.name,
        defaultLanguage: parsed.data.defaultLanguage,
        timezone: parsed.data.timezone,
        preferences: parsed.data.preferences,
      });

      return reply.status(200).send({
        data: {
          organization: updated,
          canEdit: true,
        },
      });
    } catch (error) {
      return handleOrganizationDomainError(error, request, reply);
    }
  });
}
