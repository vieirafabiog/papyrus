import {
  type AuthMeResponse,
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  uuidSchema,
} from "@docuflow/contracts";
import {
  ACCESS_EFFECTS,
  ACCESS_SCOPE_TYPES,
  DomainError,
  type PermissionAdministrationService,
} from "@docuflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE_NAME } from "../auth/auth.routes.js";
import type { AuthService } from "../auth/auth.service.js";

const assignPermissionScopeSchema = z.object({
  subjectType: z.enum(["USER", "GROUP"]),
  subjectId: uuidSchema,
  roleId: uuidSchema,
  scopeType: z.enum(ACCESS_SCOPE_TYPES),
  scopeTargetId: uuidSchema.nullable().optional(),
  effect: z.enum(ACCESS_EFFECTS).default("ALLOW"),
});

function isPermissionAdminAuthorized(me: AuthMeResponse): boolean {
  const hasAdminRole = me.roles.some((role) => role.key === "admin");
  const hasManagePermissions = me.permissions.some((perm) => perm.action === "MANAGE_PERMISSIONS");
  return hasAdminRole || hasManagePermissions;
}

async function requirePermissionAdmin(
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

  if (!isPermissionAdminAuthorized(outcome.me)) {
    void reply.status(403).send({
      error: {
        code: "FORBIDDEN",
        message: "Você não possui permissão para administrar papéis e escopos.",
        requestId: request.id,
      },
    });
    return null;
  }

  return outcome.me;
}

function mapPermissionDomainError(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "USER_NOT_FOUND":
    case "GROUP_NOT_FOUND":
    case "ROLE_NOT_FOUND":
    case "CATEGORY_NOT_FOUND":
    case "FOLDER_NOT_FOUND":
    case "DOCUMENT_NOT_FOUND":
    case "PERMISSION_ASSIGNMENT_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "PERMISSION_ASSIGNMENT_ALREADY_EXISTS":
      return { status: 409, apiCode: "CONFLICT" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

/**
 * Registers organization permission administration routes (`GET/POST/DELETE /api/v1/admin/permissions/scopes`)
 * for scoped RBAC/ACL role assignment and revocation with transactional audit logging.
 */
export async function registerPermissionRoutes(
  app: FastifyInstance,
  deps: {
    readonly authService: AuthService;
    readonly permissionAdminService: PermissionAdministrationService;
  },
): Promise<void> {
  const { authService, permissionAdminService } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/admin/permissions/roles`, async (request, reply) => {
    const actor = await requirePermissionAdmin(request, reply, authService);
    if (!actor) {
      return reply;
    }

    const items = permissionAdminService.listRoles
      ? await permissionAdminService.listRoles(actor.user.organizationId)
      : [];
    return reply.status(200).send({ data: items });
  });

  app.get(`${CONTRACTS_API_PREFIX}/admin/permissions/scopes`, async (request, reply) => {
    const actor = await requirePermissionAdmin(request, reply, authService);
    if (!actor) {
      return reply;
    }

    const items = await permissionAdminService.listAssignments(actor.user.organizationId);
    return reply.status(200).send({ data: items });
  });

  app.post(`${CONTRACTS_API_PREFIX}/admin/permissions/scopes`, async (request, reply) => {
    const actor = await requirePermissionAdmin(request, reply, authService);
    if (!actor) {
      return reply;
    }

    const parsed = assignPermissionScopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Parâmetros inválidos para atribuição de permissão.",
          requestId: request.id,
        },
      });
    }

    try {
      const assigned = await permissionAdminService.assignRoleScope({
        organizationId: actor.user.organizationId,
        actorUserId: actor.user.id,
        requestId: request.id,
        ipAddress: request.ip,
        subjectType: parsed.data.subjectType,
        subjectId: parsed.data.subjectId,
        roleId: parsed.data.roleId,
        scopeType: parsed.data.scopeType,
        scopeTargetId: parsed.data.scopeTargetId ?? null,
        effect: parsed.data.effect,
      });
      return reply.status(201).send({ data: assigned });
    } catch (error) {
      if (error instanceof DomainError) {
        const mapped = mapPermissionDomainError(error.code);
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
  });

  app.delete<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/admin/permissions/scopes/:id`,
    async (request, reply) => {
      const actor = await requirePermissionAdmin(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      if (!idParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador de atribuição de permissão inválido.",
            requestId: request.id,
          },
        });
      }

      try {
        const revoked = await permissionAdminService.revokeRoleScope({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          ipAddress: request.ip,
          assignmentId: idParsed.data,
        });
        return reply.status(200).send({ data: revoked });
      } catch (error) {
        if (error instanceof DomainError) {
          const mapped = mapPermissionDomainError(error.code);
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
    },
  );
}
