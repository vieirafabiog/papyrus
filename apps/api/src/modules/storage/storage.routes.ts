import path from "node:path";
import { type AuthMeResponse, CONTRACTS_API_PREFIX, uuidSchema } from "@docuflow/contracts";
import { DomainError, type StorageConnectionAdminService } from "@docuflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE_NAME } from "../auth/auth.routes.js";
import type { AuthService } from "../auth/auth.service.js";

const localRootDirectorySchema = z
  .string()
  .trim()
  .min(2)
  .max(512)
  .refine((value) => path.isAbsolute(value) && value !== "/", {
    message: "Informe um diretório absoluto válido distinto da raiz do sistema.",
  });

const createLocalStorageConnectionBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.literal("local").default("local"),
  rootDirectory: localRootDirectorySchema,
  isDefault: z.boolean().optional(),
  maxObjectSizeBytes: z.number().int().positive().optional(),
  minFreeBytes: z.number().int().nonnegative().optional(),
});

const updateLocalStorageConnectionBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    rootDirectory: localRootDirectorySchema.optional(),
    isDefault: z.boolean().optional(),
    maxObjectSizeBytes: z.number().int().positive().optional(),
    minFreeBytes: z.number().int().nonnegative().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "Informe ao menos um campo para atualização.",
  });

function isStorageAdminAuthorized(me: AuthMeResponse): boolean {
  const hasAdminRole = me.roles.some((role) => role.key === "admin");
  const hasManageStoragePerm = me.permissions.some(
    (perm) => perm.action === "MANAGE_STORAGE" && perm.resource === "STORAGE",
  );
  return hasAdminRole || hasManageStoragePerm;
}

async function requireStorageAdmin(
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

  if (!isStorageAdminAuthorized(outcome.me)) {
    void reply.status(403).send({
      error: {
        code: "FORBIDDEN",
        message: "Você não possui permissão para administrar conexões de armazenamento.",
        requestId: request.id,
      },
    });
    return null;
  }

  return outcome.me;
}

function mapStorageDomainError(code: string): { status: number; httpCode: string } {
  switch (code) {
    case "STORAGE_CONNECTION_NOT_FOUND":
      return { status: 404, httpCode: "NOT_FOUND" };
    case "STORAGE_CONNECTION_NAME_IN_USE":
    case "STORAGE_CONNECTION_IS_DEFAULT":
    case "STORAGE_CONNECTION_IN_USE":
    case "STORAGE_CONNECTION_INACTIVE":
      return { status: 409, httpCode: "CONFLICT" };
    default:
      return { status: 400, httpCode: "VALIDATION_ERROR" };
  }
}

export async function registerStorageRoutes(
  app: FastifyInstance,
  deps: {
    readonly authService: AuthService;
    readonly storageAdminService: StorageConnectionAdminService;
  },
): Promise<void> {
  const { authService, storageAdminService } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/admin/storage-connections`, async (request, reply) => {
    const actor = await requireStorageAdmin(request, reply, authService);
    if (!actor) {
      return reply;
    }

    const items = await storageAdminService.listConnections(actor.user.organizationId);
    return reply.status(200).send({ data: items });
  });

  app.post(`${CONTRACTS_API_PREFIX}/admin/storage-connections`, async (request, reply) => {
    const actor = await requireStorageAdmin(request, reply, authService);
    if (!actor) {
      return reply;
    }

    const parsed = createLocalStorageConnectionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Dados inválidos para cadastro da conexão de armazenamento local.",
          requestId: request.id,
        },
      });
    }

    try {
      const nonSecretConfig: Record<string, string | number | boolean | null> = {
        rootDirectory: parsed.data.rootDirectory,
      };
      if (parsed.data.maxObjectSizeBytes !== undefined) {
        nonSecretConfig.maxObjectSizeBytes = parsed.data.maxObjectSizeBytes;
      }
      if (parsed.data.minFreeBytes !== undefined) {
        nonSecretConfig.minFreeBytes = parsed.data.minFreeBytes;
      }

      const created = await storageAdminService.createConnection({
        organizationId: actor.user.organizationId,
        actorUserId: actor.user.id,
        requestId: request.id,
        name: parsed.data.name,
        kind: "local",
        isDefault: parsed.data.isDefault,
        nonSecretConfig,
      });
      return reply.status(201).send({ data: created });
    } catch (error) {
      if (error instanceof DomainError) {
        const mapped = mapStorageDomainError(error.code);
        return reply.status(mapped.status).send({
          error: {
            code: mapped.httpCode,
            message: error.message,
            requestId: request.id,
          },
        });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/admin/storage-connections/:id`,
    async (request, reply) => {
      const actor = await requireStorageAdmin(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const bodyParsed = updateLocalStorageConnectionBodySchema.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador ou dados inválidos para atualização da conexão.",
            requestId: request.id,
          },
        });
      }

      try {
        const hasConfigChanges =
          bodyParsed.data.rootDirectory !== undefined ||
          bodyParsed.data.maxObjectSizeBytes !== undefined ||
          bodyParsed.data.minFreeBytes !== undefined;

        let nextConfig: Record<string, string | number | boolean | null> | undefined;
        if (hasConfigChanges) {
          const existingList = await storageAdminService.listConnections(actor.user.organizationId);
          const current = existingList.find((item) => item.id === idParsed.data);
          if (!current) {
            throw new DomainError(
              "STORAGE_CONNECTION_NOT_FOUND",
              "Conexão de armazenamento não encontrada.",
            );
          }
          nextConfig = { ...current.nonSecretConfig };
          if (bodyParsed.data.rootDirectory !== undefined) {
            nextConfig.rootDirectory = bodyParsed.data.rootDirectory;
          }
          if (bodyParsed.data.maxObjectSizeBytes !== undefined) {
            nextConfig.maxObjectSizeBytes = bodyParsed.data.maxObjectSizeBytes;
          }
          if (bodyParsed.data.minFreeBytes !== undefined) {
            nextConfig.minFreeBytes = bodyParsed.data.minFreeBytes;
          }
        }

        const updated = await storageAdminService.updateConnection({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          connectionId: idParsed.data,
          name: bodyParsed.data.name,
          isDefault: bodyParsed.data.isDefault,
          nonSecretConfig: nextConfig,
        });
        return reply.status(200).send({ data: updated });
      } catch (error) {
        if (error instanceof DomainError) {
          const mapped = mapStorageDomainError(error.code);
          return reply.status(mapped.status).send({
            error: {
              code: mapped.httpCode,
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
    `${CONTRACTS_API_PREFIX}/admin/storage-connections/:id/test`,
    async (request, reply) => {
      const actor = await requireStorageAdmin(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      if (!idParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador de conexão inválido.",
            requestId: request.id,
          },
        });
      }

      try {
        const result = await storageAdminService.testConnection({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          connectionId: idParsed.data,
        });
        return reply.status(200).send({ data: result });
      } catch (error) {
        if (error instanceof DomainError) {
          const mapped = mapStorageDomainError(error.code);
          return reply.status(mapped.status).send({
            error: {
              code: mapped.httpCode,
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
    `${CONTRACTS_API_PREFIX}/admin/storage-connections/:id/default`,
    async (request, reply) => {
      const actor = await requireStorageAdmin(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      if (!idParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador de conexão inválido.",
            requestId: request.id,
          },
        });
      }

      try {
        const updated = await storageAdminService.setDefaultConnection({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          connectionId: idParsed.data,
        });
        return reply.status(200).send({ data: updated });
      } catch (error) {
        if (error instanceof DomainError) {
          const mapped = mapStorageDomainError(error.code);
          return reply.status(mapped.status).send({
            error: {
              code: mapped.httpCode,
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
    `${CONTRACTS_API_PREFIX}/admin/storage-connections/:id/activate`,
    async (request, reply) => {
      const actor = await requireStorageAdmin(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      if (!idParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador de conexão inválido.",
            requestId: request.id,
          },
        });
      }

      try {
        const updated = await storageAdminService.activateConnection({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          connectionId: idParsed.data,
        });
        return reply.status(200).send({ data: updated });
      } catch (error) {
        if (error instanceof DomainError) {
          const mapped = mapStorageDomainError(error.code);
          return reply.status(mapped.status).send({
            error: {
              code: mapped.httpCode,
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
    `${CONTRACTS_API_PREFIX}/admin/storage-connections/:id/deactivate`,
    async (request, reply) => {
      const actor = await requireStorageAdmin(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      if (!idParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador de conexão inválido.",
            requestId: request.id,
          },
        });
      }

      try {
        const updated = await storageAdminService.deactivateConnection({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          connectionId: idParsed.data,
        });
        return reply.status(200).send({ data: updated });
      } catch (error) {
        if (error instanceof DomainError) {
          const mapped = mapStorageDomainError(error.code);
          return reply.status(mapped.status).send({
            error: {
              code: mapped.httpCode,
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
