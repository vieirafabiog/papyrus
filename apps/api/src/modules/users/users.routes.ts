import {
  type AuthMeResponse,
  CONTRACTS_API_PREFIX,
  createUserRequestSchema,
  updateUserRequestSchema,
  uuidSchema,
} from "@papyrus/contracts";
import { DomainError, type UserAdministrationService } from "@papyrus/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME } from "../auth/auth.routes.js";
import type { AuthService } from "../auth/auth.service.js";

function mapDomainErrorStatus(code: string): number {
  switch (code) {
    case "USER_NOT_FOUND":
      return 404;
    case "EMAIL_ALREADY_IN_USE":
    case "LAST_ACTIVE_ADMIN":
      return 409;
    default:
      return 400;
  }
}

function isUserAdminAuthorized(me: AuthMeResponse): boolean {
  const hasAdminRole = me.roles.some((role) => role.key === "admin");
  const hasManageUsersPerm = me.permissions.some(
    (perm) => perm.action === "MANAGE_USERS" && perm.resource === "USER",
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

  if (!isUserAdminAuthorized(outcome.me)) {
    void reply.status(403).send({
      error: {
        code: "FORBIDDEN",
        message: "Você não possui permissão para administrar usuários.",
        requestId: request.id,
      },
    });
    return null;
  }

  return outcome.me;
}

export async function registerUserRoutes(
  app: FastifyInstance,
  deps: {
    readonly authService: AuthService;
    readonly userAdminService: UserAdministrationService;
  },
): Promise<void> {
  const { authService, userAdminService } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/admin/users`, async (request, reply) => {
    const actor = await requireAdminActor(request, reply, authService);
    if (!actor) {
      return reply;
    }

    const items = await userAdminService.listUsers(actor.user.organizationId);
    return reply.status(200).send({ data: items });
  });

  app.post(`${CONTRACTS_API_PREFIX}/admin/users`, async (request, reply) => {
    const actor = await requireAdminActor(request, reply, authService);
    if (!actor) {
      return reply;
    }

    const parsed = createUserRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Dados inválidos para criação de usuário.",
          requestId: request.id,
        },
      });
    }

    try {
      const created = await userAdminService.createUser({
        organizationId: actor.user.organizationId,
        actorUserId: actor.user.id,
        requestId: request.id,
        email: parsed.data.email,
        fullName: parsed.data.fullName,
        password: parsed.data.password,
      });
      return reply.status(201).send({ data: created });
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.status(mapDomainErrorStatus(error.code)).send({
          error: {
            code: error.code === "EMAIL_ALREADY_IN_USE" ? "CONFLICT" : "VALIDATION_ERROR",
            message: error.message,
            requestId: request.id,
          },
        });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/admin/users/:id`,
    async (request, reply) => {
      const actor = await requireAdminActor(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const bodyParsed = updateUserRequestSchema.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador ou dados de atualização inválidos.",
            requestId: request.id,
          },
        });
      }

      try {
        const updated = await userAdminService.updateUser({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          targetUserId: idParsed.data,
          fullName: bodyParsed.data.fullName,
        });
        return reply.status(200).send({ data: updated });
      } catch (error) {
        if (error instanceof DomainError) {
          return reply.status(mapDomainErrorStatus(error.code)).send({
            error: {
              code: error.code === "USER_NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_ERROR",
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
    `${CONTRACTS_API_PREFIX}/admin/users/:id/deactivate`,
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
            message: "Identificador de usuário inválido.",
            requestId: request.id,
          },
        });
      }

      try {
        const updated = await userAdminService.deactivateUser({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          targetUserId: idParsed.data,
        });
        return reply.status(200).send({ data: updated });
      } catch (error) {
        if (error instanceof DomainError) {
          return reply.status(mapDomainErrorStatus(error.code)).send({
            error: {
              code: error.code === "USER_NOT_FOUND" ? "NOT_FOUND" : "CONFLICT",
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
    `${CONTRACTS_API_PREFIX}/admin/users/:id/reactivate`,
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
            message: "Identificador de usuário inválido.",
            requestId: request.id,
          },
        });
      }

      try {
        const updated = await userAdminService.reactivateUser({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          targetUserId: idParsed.data,
        });
        return reply.status(200).send({ data: updated });
      } catch (error) {
        if (error instanceof DomainError) {
          return reply.status(mapDomainErrorStatus(error.code)).send({
            error: {
              code: error.code === "USER_NOT_FOUND" ? "NOT_FOUND" : "CONFLICT",
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
