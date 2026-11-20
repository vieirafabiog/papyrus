import {
  type AuthMeResponse,
  CONTRACTS_API_PREFIX,
  createStorageConnectionContractSchema,
  updateStorageConnectionContractSchema,
  uuidSchema,
} from "@docuflow/contracts";
import { DomainError, type StorageConnectionAdminService } from "@docuflow/domain";
import { sanitizeStorageErrorMessage } from "@docuflow/storage-core";
import {
  type S3EndpointSecurityPolicy,
  type S3StorageConfigInput,
  parseS3StorageConfig,
} from "@docuflow/storage-s3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME } from "../auth/auth.routes.js";
import type { AuthService } from "../auth/auth.service.js";

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

function readStringOrUndefined(
  value: string | number | boolean | null | undefined,
): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBooleanOrDefault(
  value: string | number | boolean | null | undefined,
  fallback: boolean,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readIntOrDefault(
  value: string | number | boolean | null | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function buildS3NonSecretConfigRecord(
  validated: ReturnType<typeof parseS3StorageConfig>,
): Record<string, string | number | boolean | null> {
  const record: Record<string, string | number | boolean | null> = {
    endpoint: validated.endpoint,
    region: validated.region,
    bucket: validated.bucket,
    forcePathStyle: validated.forcePathStyle,
    tlsRejectUnauthorized: validated.tls.rejectUnauthorized,
    tlsAllowInsecureHttp: validated.tls.allowInsecureHttp,
    connectionTimeoutMs: validated.timeouts.connectionTimeoutMs,
    requestTimeoutMs: validated.timeouts.requestTimeoutMs,
  };
  if (validated.keyPrefix) {
    record.keyPrefix = validated.keyPrefix;
  }
  if (validated.tls.caCertificatePem) {
    record.caCertificatePem = validated.tls.caCertificatePem;
  }
  return record;
}

export async function registerStorageRoutes(
  app: FastifyInstance,
  deps: {
    readonly authService: AuthService;
    readonly storageAdminService: StorageConnectionAdminService;
    readonly s3SecurityPolicy?: S3EndpointSecurityPolicy | undefined;
  },
): Promise<void> {
  const { authService, storageAdminService, s3SecurityPolicy } = deps;

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

    const parsed = createStorageConnectionContractSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Dados inválidos para cadastro da conexão de armazenamento.",
          requestId: request.id,
        },
      });
    }

    try {
      const payload = parsed.data;

      if (payload.kind === "local") {
        const nonSecretConfig: Record<string, string | number | boolean | null> = {
          rootDirectory: payload.rootDirectory,
        };
        if (payload.maxObjectSizeBytes !== undefined) {
          nonSecretConfig.maxObjectSizeBytes = payload.maxObjectSizeBytes;
        }
        if (payload.minFreeBytes !== undefined) {
          nonSecretConfig.minFreeBytes = payload.minFreeBytes;
        }

        const created = await storageAdminService.createConnection({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          name: payload.name,
          kind: "local",
          isDefault: payload.isDefault,
          nonSecretConfig,
        });
        return reply.status(201).send({ data: created });
      }

      const validatedS3 = parseS3StorageConfig(
        {
          endpoint: payload.endpoint,
          region: payload.region,
          bucket: payload.bucket,
          forcePathStyle: payload.forcePathStyle,
          keyPrefix: payload.keyPrefix,
          tls: payload.tls,
          timeouts: payload.timeouts,
          credentials: payload.credentials,
        },
        s3SecurityPolicy,
      );

      const s3Credentials: Record<string, string> = {
        accessKeyId: validatedS3.credentials.accessKeyId,
        secretAccessKey: validatedS3.credentials.secretAccessKey,
      };
      if (validatedS3.credentials.sessionToken) {
        s3Credentials.sessionToken = validatedS3.credentials.sessionToken;
      }

      const created = await storageAdminService.createConnection({
        organizationId: actor.user.organizationId,
        actorUserId: actor.user.id,
        requestId: request.id,
        name: payload.name,
        kind: "s3",
        isDefault: payload.isDefault,
        nonSecretConfig: buildS3NonSecretConfigRecord(validatedS3),
        credentials: s3Credentials,
      });
      return reply.status(201).send({ data: created });
    } catch (error) {
      if (error instanceof DomainError) {
        const mapped = mapStorageDomainError(error.code);
        return reply.status(mapped.status).send({
          error: {
            code: mapped.httpCode,
            message: sanitizeStorageErrorMessage(error.message),
            requestId: request.id,
          },
        });
      }
      if (error instanceof Error && error.name === "StorageError") {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: sanitizeStorageErrorMessage(error.message),
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
      const bodyParsed = updateStorageConnectionContractSchema.safeParse(request.body);
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
        const body = bodyParsed.data;
        const existingList = await storageAdminService.listConnections(actor.user.organizationId);
        const current = existingList.find((item) => item.id === idParsed.data);
        if (!current) {
          throw new DomainError(
            "STORAGE_CONNECTION_NOT_FOUND",
            "Conexão de armazenamento não encontrada.",
          );
        }

        let nextConfig: Record<string, string | number | boolean | null> | undefined;
        let nextCredentials: Record<string, string> | undefined;

        if (current.kind === "local") {
          const hasLocalChanges =
            body.rootDirectory !== undefined ||
            body.maxObjectSizeBytes !== undefined ||
            body.minFreeBytes !== undefined;

          if (hasLocalChanges) {
            nextConfig = { ...current.nonSecretConfig };
            if (body.rootDirectory !== undefined) {
              nextConfig.rootDirectory = body.rootDirectory;
            }
            if (body.maxObjectSizeBytes !== undefined) {
              nextConfig.maxObjectSizeBytes = body.maxObjectSizeBytes;
            }
            if (body.minFreeBytes !== undefined) {
              nextConfig.minFreeBytes = body.minFreeBytes;
            }
          }
        } else if (current.kind === "s3") {
          const hasS3ConfigChanges =
            body.endpoint !== undefined ||
            body.region !== undefined ||
            body.bucket !== undefined ||
            body.forcePathStyle !== undefined ||
            body.keyPrefix !== undefined ||
            body.tls !== undefined ||
            body.timeouts !== undefined;

          if (hasS3ConfigChanges || body.credentials !== undefined) {
            const candidateInput: S3StorageConfigInput = {
              endpoint:
                body.endpoint ?? readStringOrUndefined(current.nonSecretConfig.endpoint) ?? "",
              region: body.region ?? readStringOrUndefined(current.nonSecretConfig.region) ?? "",
              bucket: body.bucket ?? readStringOrUndefined(current.nonSecretConfig.bucket) ?? "",
              forcePathStyle:
                body.forcePathStyle ??
                readBooleanOrDefault(current.nonSecretConfig.forcePathStyle, false),
              keyPrefix:
                body.keyPrefix === null
                  ? undefined
                  : (body.keyPrefix ?? readStringOrUndefined(current.nonSecretConfig.keyPrefix)),
              tls: {
                rejectUnauthorized:
                  body.tls?.rejectUnauthorized ??
                  readBooleanOrDefault(current.nonSecretConfig.tlsRejectUnauthorized, true),
                allowInsecureHttp:
                  body.tls?.allowInsecureHttp ??
                  readBooleanOrDefault(current.nonSecretConfig.tlsAllowInsecureHttp, false),
                caCertificatePem:
                  body.tls?.caCertificatePem ??
                  readStringOrUndefined(current.nonSecretConfig.caCertificatePem),
              },
              timeouts: {
                connectionTimeoutMs:
                  body.timeouts?.connectionTimeoutMs ??
                  readIntOrDefault(current.nonSecretConfig.connectionTimeoutMs, 5_000),
                requestTimeoutMs:
                  body.timeouts?.requestTimeoutMs ??
                  readIntOrDefault(current.nonSecretConfig.requestTimeoutMs, 30_000),
              },
              credentials: body.credentials ?? {
                accessKeyId: "placeholder-keep-existing",
                secretAccessKey: "placeholder-keep-existing",
              },
            };

            const validatedS3 = parseS3StorageConfig(candidateInput, s3SecurityPolicy);
            if (hasS3ConfigChanges) {
              nextConfig = buildS3NonSecretConfigRecord(validatedS3);
            }
            if (body.credentials !== undefined) {
              nextCredentials = {
                accessKeyId: validatedS3.credentials.accessKeyId,
                secretAccessKey: validatedS3.credentials.secretAccessKey,
              };
              if (validatedS3.credentials.sessionToken) {
                nextCredentials.sessionToken = validatedS3.credentials.sessionToken;
              }
            }
          }
        }

        const updated = await storageAdminService.updateConnection({
          organizationId: actor.user.organizationId,
          actorUserId: actor.user.id,
          requestId: request.id,
          connectionId: idParsed.data,
          name: body.name,
          isDefault: body.isDefault,
          nonSecretConfig: nextConfig,
          credentials: nextCredentials,
        });
        return reply.status(200).send({ data: updated });
      } catch (error) {
        if (error instanceof DomainError) {
          const mapped = mapStorageDomainError(error.code);
          return reply.status(mapped.status).send({
            error: {
              code: mapped.httpCode,
              message: sanitizeStorageErrorMessage(error.message),
              requestId: request.id,
            },
          });
        }
        if (error instanceof Error && error.name === "StorageError") {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: sanitizeStorageErrorMessage(error.message),
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
              message: sanitizeStorageErrorMessage(error.message),
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
              message: sanitizeStorageErrorMessage(error.message),
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
              message: sanitizeStorageErrorMessage(error.message),
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
              message: sanitizeStorageErrorMessage(error.message),
              requestId: request.id,
            },
          });
        }
        throw error;
      }
    },
  );
}
