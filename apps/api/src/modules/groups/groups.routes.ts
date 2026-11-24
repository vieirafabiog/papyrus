import {
  type AuthMeResponse,
  CONTRACTS_API_PREFIX,
  addGroupMemberRequestSchema,
  createGroupRequestSchema,
  uuidSchema,
} from "@docuflow/contracts";
import { DomainError, type GroupAdministrationService } from "@docuflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME } from "../auth/auth.routes.js";
import type { AuthService } from "../auth/auth.service.js";

function mapGroupDomainErrorStatus(code: string): number {
  switch (code) {
    case "GROUP_NOT_FOUND":
    case "USER_NOT_FOUND":
    case "GROUP_MEMBER_NOT_FOUND":
      return 404;
    case "GROUP_NAME_ALREADY_IN_USE":
    case "DUPLICATE_GROUP_MEMBERSHIP":
      return 409;
    default:
      return 400;
  }
}

function isGroupAdminAuthorized(me: AuthMeResponse): boolean {
  const hasAdminRole = me.roles.some((role) => role.key === "admin");
  const hasManageUsersPerm = me.permissions.some(
    (perm) => perm.action === "MANAGE_USERS" && perm.resource === "GROUP",
  );
  return hasAdminRole || hasManageUsersPerm;
}

async function requireAdminActor(
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

  if (!isGroupAdminAuthorized(outcome.me)) {
    void reply.status(403).send({
      error: {
        code: "FORBIDDEN",
        message: "Você não possui permissão para administrar grupos.",
        requestId: request.id,
      },
    });
    return null;
  }

  return outcome.me;
}

export async function registerGroupRoutes(
  app: FastifyInstance,
  deps: {
    readonly authService: AuthService;
    readonly groupAdminService: GroupAdministrationService;
  },
): Promise<void> {
  const { authService, groupAdminService } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/admin/groups`, async (request, reply) => {
    const actor = await requireAdminActor(request, reply, authService);
    if (!actor) {
      return reply;
    }

    const items = await groupAdminService.listGroups(actor.user.organizationId);
    return reply.status(200).send({ data: items });
  });

  app.post(`${CONTRACTS_API_PREFIX}/admin/groups`, async (request, reply) => {
    const actor = await requireAdminActor(request, reply, authService);
    if (!actor) {
      return reply;
    }

    const parsed = createGroupRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Dados inválidos para criação do grupo.",
          requestId: request.id,
        },
      });
    }

    try {
      const created = await groupAdminService.createGroup({
        organizationId: actor.user.organizationId,
        actorUserId: actor.user.id,
        requestId: request.id,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
      });
      return reply.status(201).send({ data: created });
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.status(mapGroupDomainErrorStatus(error.code)).send({
          error: {
            code: error.code === "GROUP_NAME_ALREADY_IN_USE" ? "CONFLICT" : "VALIDATION_ERROR",
            message: error.message,
            requestId: request.id,
          },
        });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/admin/groups/:id/members`,
    async (request, reply) => {
      const actor = await requireAdminActor(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      if (!idParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador de grupo inválido.",
            requestId: request.id,
          },
        });
      }

      try {
        const members = await groupAdminService.listMembers(
          actor.user.organizationId,
          idParsed.data,
        );
        return reply.status(200).send({ data: members });
      } catch (error) {
        if (error instanceof DomainError) {
          return reply.status(mapGroupDomainErrorStatus(error.code)).send({
            error: {
              code: "NOT_FOUND",
              message: error.message,
              requestId: request.id,
            },
          });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/admin/groups/:id/members`,
    async (request, reply) => {
      const actor = await requireAdminActor(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const bodyParsed = addGroupMemberRequestSchema.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador de grupo ou usuário inválido.",
            requestId: request.id,
          },
        });
      }

      try {
        await groupAdminService.addMember({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          groupId: idParsed.data,
          targetUserId: bodyParsed.data.userId,
        });
        return reply.status(201).send({ data: { linked: true } });
      } catch (error) {
        if (error instanceof DomainError) {
          const status = mapGroupDomainErrorStatus(error.code);
          return reply.status(status).send({
            error: {
              code: status === 404 ? "NOT_FOUND" : "CONFLICT",
              message: error.message,
              requestId: request.id,
            },
          });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    `${CONTRACTS_API_PREFIX}/admin/groups/:id/members/:userId`,
    async (request, reply) => {
      const actor = await requireAdminActor(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const groupIdParsed = uuidSchema.safeParse(request.params.id);
      const userIdParsed = uuidSchema.safeParse(request.params.userId);
      if (!groupIdParsed.success || !userIdParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador inválido.",
            requestId: request.id,
          },
        });
      }

      try {
        await groupAdminService.removeMember({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          groupId: groupIdParsed.data,
          targetUserId: userIdParsed.data,
        });
        return reply.status(200).send({ data: { removed: true } });
      } catch (error) {
        if (error instanceof DomainError) {
          return reply.status(mapGroupDomainErrorStatus(error.code)).send({
            error: {
              code: "NOT_FOUND",
              message: error.message,
              requestId: request.id,
            },
          });
        }
        throw error;
      }
    },
  );
}
