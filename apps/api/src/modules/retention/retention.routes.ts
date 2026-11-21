import { evaluateAuthorization } from "@docuflow/auth";
import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  createRetentionPolicyRequestSchema,
  placeDocumentHoldRequestSchema,
  releaseDocumentHoldRequestSchema,
  updateRetentionPolicyRequestSchema,
  uuidSchema,
} from "@docuflow/contracts";
import type { AuthorizationRepository } from "@docuflow/database";
import { DomainError, type RetentionGovernanceService } from "@docuflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type DocumentAuthorizationGuard,
  buildRolePermissionsLookup,
  toSubjectContext,
} from "../../plugins/authorization.js";
import { SESSION_COOKIE_NAME } from "../auth/auth.routes.js";
import type { AuthService } from "../auth/auth.service.js";

export interface RetentionRoutesDependencies {
  readonly authService: AuthService;
  readonly authzRepository: AuthorizationRepository;
  readonly retentionService: RetentionGovernanceService;
  readonly documentGuard?: DocumentAuthorizationGuard | undefined;
}

function mapRetentionDomainError(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "RETENTION_POLICY_NOT_FOUND":
    case "CATEGORY_NOT_FOUND":
    case "DOCUMENT_NOT_FOUND":
    case "HOLD_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "RETENTION_HOLD_ACTIVE":
      return { status: 409, apiCode: "RETENTION_HOLD_ACTIVE" };
    case "RETENTION_POLICY_NAME_IN_USE":
    case "HOLD_ALREADY_RELEASED":
    case "PURGE_WINDOW_NOT_ELAPSED":
      return { status: 409, apiCode: "CONFLICT" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

async function requireRetentionAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  authzRepository: AuthorizationRepository,
): Promise<{ readonly organizationId: string; readonly userId: string } | null> {
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

  const isGlobalPermitted =
    evaluateAuthorization(
      subject,
      { action: "MANAGE_PERMISSIONS", resource: "ROLE", scope: { type: "GLOBAL" } },
      rolePermissions,
    ).allowed ||
    evaluateAuthorization(
      subject,
      { action: "UPDATE", resource: "ORGANIZATION", scope: { type: "GLOBAL" } },
      rolePermissions,
    ).allowed;

  if (!isGlobalPermitted) {
    void reply.status(403).send({
      error: {
        code: "FORBIDDEN",
        message: "Você não possui permissão para administrar políticas de retenção.",
        requestId: request.id,
      },
    });
    return null;
  }

  return {
    organizationId: outcome.me.user.organizationId,
    userId: outcome.me.user.id,
  };
}

function handleRetentionDomainError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    const mapped = mapRetentionDomainError(error.code);
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

/**
 * Registers retention policy administration endpoints (`/api/v1/admin/retention-policies`)
 * and document legal hold / purge-eligibility endpoints (`/api/v1/documents/:id/retention-holds`).
 */
export async function registerRetentionRoutes(
  app: FastifyInstance,
  deps: RetentionRoutesDependencies,
): Promise<void> {
  const { authService, authzRepository, retentionService, documentGuard } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/admin/retention-policies`, async (request, reply) => {
    const actor = await requireRetentionAdmin(request, reply, authService, authzRepository);
    if (!actor) {
      return reply;
    }

    const items = await retentionService.listPolicies(actor.organizationId);
    return reply.status(200).send({ data: { items } });
  });

  app.post(`${CONTRACTS_API_PREFIX}/admin/retention-policies`, async (request, reply) => {
    const actor = await requireRetentionAdmin(request, reply, authService, authzRepository);
    if (!actor) {
      return reply;
    }

    const parsed = createRetentionPolicyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            parsed.error.issues[0]?.message ??
            "Dados inválidos para criação da política de retenção.",
          requestId: request.id,
        },
      });
    }

    try {
      const created = await retentionService.createPolicy({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: request.id,
        name: parsed.data.name,
        categoryId: parsed.data.categoryId ?? null,
        retentionDays: parsed.data.retentionDays,
        trashGraceDays: parsed.data.trashGraceDays,
        actionOnExpiry: parsed.data.actionOnExpiry,
        isActive: parsed.data.isActive,
      });
      return reply.status(201).send({ data: created });
    } catch (error) {
      return handleRetentionDomainError(error, request, reply);
    }
  });

  app.patch<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/admin/retention-policies/:id`,
    async (request, reply) => {
      const actor = await requireRetentionAdmin(request, reply, authService, authzRepository);
      if (!actor) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const bodyParsed = updateRetentionPolicyRequestSchema.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: !idParsed.success
              ? "Identificador da política inválido."
              : !bodyParsed.success
                ? (bodyParsed.error.issues[0]?.message ?? "Dados inválidos para atualização.")
                : "Dados inválidos para atualização.",
            requestId: request.id,
          },
        });
      }

      try {
        const updated = await retentionService.updatePolicy({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          requestId: request.id,
          policyId: idParsed.data,
          name: bodyParsed.data.name,
          categoryId: bodyParsed.data.categoryId,
          retentionDays: bodyParsed.data.retentionDays,
          trashGraceDays: bodyParsed.data.trashGraceDays,
          actionOnExpiry: bodyParsed.data.actionOnExpiry,
          isActive: bodyParsed.data.isActive,
        });
        return reply.status(200).send({ data: updated });
      } catch (error) {
        return handleRetentionDomainError(error, request, reply);
      }
    },
  );

  if (documentGuard) {
    app.get<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/documents/:id/retention-holds`,
      async (request, reply) => {
        const ctx = await documentGuard.requireSubject(request, reply);
        if (!ctx) {
          return reply;
        }

        const idParsed = uuidSchema.safeParse(request.params.id);
        if (!idParsed.success) {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: "Identificador de documento inválido.",
              requestId: request.id,
            },
          });
        }

        const doc = await documentGuard.authorizeDocument(
          ctx,
          idParsed.data,
          "READ",
          reply,
          request.id,
          request.ip,
        );
        if (!doc) {
          return reply;
        }

        const [holds, purgeEligibility] = await Promise.all([
          retentionService.listDocumentHolds(ctx.me.user.organizationId, doc.id),
          retentionService.evaluatePurgeForDocument({
            organizationId: ctx.me.user.organizationId,
            documentId: doc.id,
          }),
        ]);

        return reply.status(200).send({
          data: { holds, purgeEligibility },
        });
      },
    );

    app.post<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/documents/:id/retention-holds`,
      async (request, reply) => {
        const ctx = await documentGuard.requireSubject(request, reply);
        if (!ctx) {
          return reply;
        }

        const idParsed = uuidSchema.safeParse(request.params.id);
        const bodyParsed = placeDocumentHoldRequestSchema.safeParse(request.body);
        if (!idParsed.success || !bodyParsed.success) {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: !idParsed.success
                ? "Identificador de documento inválido."
                : !bodyParsed.success
                  ? (bodyParsed.error.issues[0]?.message ?? "Dados inválidos para bloqueio (hold).")
                  : "Dados inválidos para bloqueio (hold).",
              requestId: request.id,
            },
          });
        }

        const doc = await documentGuard.authorizeDocument(
          ctx,
          idParsed.data,
          "MANAGE_PERMISSIONS",
          reply,
          request.id,
          request.ip,
        );
        if (!doc) {
          return reply;
        }

        try {
          const hold = await retentionService.placeHold({
            organizationId: ctx.me.user.organizationId,
            actorUserId: ctx.me.user.id,
            requestId: request.id,
            documentId: doc.id,
            reason: bodyParsed.data.reason,
          });
          return reply.status(201).send({ data: hold });
        } catch (error) {
          return handleRetentionDomainError(error, request, reply);
        }
      },
    );

    app.post<{ Params: { id: string; holdId: string } }>(
      `${CONTRACTS_API_PREFIX}/documents/:id/retention-holds/:holdId/release`,
      async (request, reply) => {
        const ctx = await documentGuard.requireSubject(request, reply);
        if (!ctx) {
          return reply;
        }

        const idParsed = uuidSchema.safeParse(request.params.id);
        const holdIdParsed = uuidSchema.safeParse(request.params.holdId);
        const bodyParsed = releaseDocumentHoldRequestSchema.safeParse(request.body);
        if (!idParsed.success || !holdIdParsed.success || !bodyParsed.success) {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message:
                !idParsed.success || !holdIdParsed.success
                  ? "Identificadores inválidos para liberação de bloqueio."
                  : !bodyParsed.success
                    ? (bodyParsed.error.issues[0]?.message ?? "Dados inválidos para liberação.")
                    : "Dados inválidos para liberação.",
              requestId: request.id,
            },
          });
        }

        const doc = await documentGuard.authorizeDocument(
          ctx,
          idParsed.data,
          "MANAGE_PERMISSIONS",
          reply,
          request.id,
          request.ip,
        );
        if (!doc) {
          return reply;
        }

        try {
          const released = await retentionService.releaseHold({
            organizationId: ctx.me.user.organizationId,
            actorUserId: ctx.me.user.id,
            requestId: request.id,
            documentId: doc.id,
            holdId: holdIdParsed.data,
            releaseReason: bodyParsed.data.releaseReason,
          });
          return reply.status(200).send({ data: released });
        } catch (error) {
          return handleRetentionDomainError(error, request, reply);
        }
      },
    );

    app.post<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/documents/:id/purge-check`,
      async (request, reply) => {
        const ctx = await documentGuard.requireSubject(request, reply);
        if (!ctx) {
          return reply;
        }

        const idParsed = uuidSchema.safeParse(request.params.id);
        if (!idParsed.success) {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: "Identificador de documento inválido.",
              requestId: request.id,
            },
          });
        }

        const doc = await documentGuard.authorizeDocument(
          ctx,
          idParsed.data,
          "DELETE",
          reply,
          request.id,
          request.ip,
        );
        if (!doc) {
          return reply;
        }

        try {
          const evaluation = await retentionService.assertPurgeAllowed({
            organizationId: ctx.me.user.organizationId,
            documentId: doc.id,
          });
          return reply.status(200).send({ data: evaluation });
        } catch (error) {
          return handleRetentionDomainError(error, request, reply);
        }
      },
    );
  }
}
