import { evaluateAuthorization } from "@papyrus/auth";
import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  SAFE_UPLOAD_FORMAT_CATALOG,
  updateUploadLimitsRequestSchema,
} from "@papyrus/contracts";
import type { AuthorizationRepository } from "@papyrus/database";
import { DomainError, type UploadLimitsService } from "@papyrus/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildRolePermissionsLookup, toSubjectContext } from "../../plugins/authorization.js";
import { SESSION_COOKIE_NAME } from "../auth/auth.routes.js";
import type { AuthService } from "../auth/auth.service.js";

export interface UploadLimitsRoutesDependencies {
  readonly authService: AuthService;
  readonly authzRepository: AuthorizationRepository;
  readonly uploadLimitsService: UploadLimitsService;
}

function mapUploadLimitsDomainError(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "ORGANIZATION_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

function handleDomainError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    const mapped = mapUploadLimitsDomainError(error.code);
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

async function resolveUploadLimitsActor(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  authzRepository: AuthorizationRepository,
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

  const canManageStorage = evaluateAuthorization(
    subject,
    { action: "MANAGE_STORAGE", resource: "STORAGE", scope: { type: "GLOBAL" } },
    rolePermissions,
  ).allowed;

  const canUpdateOrg = evaluateAuthorization(
    subject,
    { action: "UPDATE", resource: "ORGANIZATION", scope: { type: "GLOBAL" } },
    rolePermissions,
  ).allowed;

  return {
    organizationId: outcome.me.user.organizationId,
    userId: outcome.me.user.id,
    canEdit: canManageStorage || canUpdateOrg,
  };
}

/**
 * Registers HTTP routes for reading effective upload limits (for authorized uploaders
 * and UI pre-validation) and administering size/extension limits consistently with
 * API, proxy, and worker enforcement.
 */
export async function registerUploadLimitsRoutes(
  app: FastifyInstance,
  deps: UploadLimitsRoutesDependencies,
): Promise<void> {
  const { authService, authzRepository, uploadLimitsService } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/uploads/limits`, async (request, reply) => {
    const actor = await resolveUploadLimitsActor(request, reply, authService, authzRepository);
    if (!actor) {
      return reply;
    }

    try {
      const view = await uploadLimitsService.getLimits(actor.organizationId);
      return reply.status(200).send({
        data: {
          configured: view.configured,
          effective: view.effective,
          supportedCatalog: [...SAFE_UPLOAD_FORMAT_CATALOG],
          canEdit: actor.canEdit,
          updatedAt: view.updatedAt,
        },
      });
    } catch (error) {
      return handleDomainError(error, request, reply);
    }
  });

  app.patch(`${CONTRACTS_API_PREFIX}/admin/upload-limits`, async (request, reply) => {
    const actor = await resolveUploadLimitsActor(request, reply, authService, authzRepository);
    if (!actor) {
      return reply;
    }

    if (!actor.canEdit) {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Você não possui permissão para alterar limites e extensões de upload.",
          requestId: request.id,
        },
      });
    }

    const parsed = updateUploadLimitsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            parsed.error.issues[0]?.message ??
            "Dados inválidos para configuração de limites de upload.",
          requestId: request.id,
        },
      });
    }

    try {
      const updated = await uploadLimitsService.updateLimits({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: request.id,
        maxFileSizeBytes: parsed.data.maxFileSizeBytes,
        allowedExtensions: parsed.data.allowedExtensions,
        enforceDeclaredExtensionMatch: parsed.data.enforceDeclaredExtensionMatch,
      });

      return reply.status(200).send({
        data: {
          configured: updated.configured,
          effective: updated.effective,
          supportedCatalog: [...SAFE_UPLOAD_FORMAT_CATALOG],
          canEdit: true,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (error) {
      return handleDomainError(error, request, reply);
    }
  });
}
