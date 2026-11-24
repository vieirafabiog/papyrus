import {
  type AuthMeResponse,
  CONTRACTS_API_PREFIX,
  type NotificationItem,
  notificationListQuerySchema,
  uuidSchema,
} from "@papyrus/contracts";
import type { InAppNotificationRecord, InAppNotificationService } from "@papyrus/notifications";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME } from "../auth/auth.routes.js";
import type { AuthService } from "../auth/auth.service.js";

export interface NotificationRoutesDependencies {
  readonly authService: AuthService;
  readonly notificationService: InAppNotificationService;
}

function serializeNotification(record: InAppNotificationRecord): NotificationItem {
  return {
    id: record.id,
    recipientUserId: record.recipientUserId,
    channel: record.channel,
    kind: record.kind,
    title: record.title,
    body: record.body,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    readAt: record.readAt ? record.readAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
  };
}

async function requireAuthenticatedUser(
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

  return outcome.me;
}

/**
 * Registers authenticated user internal notification inbox endpoints:
 * - `GET /api/v1/notifications`
 * - `POST /api/v1/notifications/:id/read`
 */
export async function registerNotificationRoutes(
  app: FastifyInstance,
  deps: NotificationRoutesDependencies,
): Promise<void> {
  const { authService, notificationService } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/notifications`, async (request, reply) => {
    const actor = await requireAuthenticatedUser(request, reply, authService);
    if (!actor) {
      return reply;
    }

    const queryParsed = notificationListQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            queryParsed.error.issues[0]?.message ??
            "Parâmetros inválidos para listagem de notificações.",
          requestId: request.id,
        },
      });
    }

    const result = await notificationService.listForUser({
      organizationId: actor.user.organizationId,
      recipientUserId: actor.user.id,
      unreadOnly: queryParsed.data.unreadOnly,
      kind: queryParsed.data.kind,
      page: queryParsed.data.page,
      pageSize: queryParsed.data.pageSize,
    });

    reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
    reply.header("Pragma", "no-cache");
    reply.header("Vary", "Cookie, Origin");

    return reply.status(200).send({
      data: {
        items: result.items.map(serializeNotification),
        unreadCount: result.unreadCount,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          totalItems: result.totalItems,
          totalPages: result.totalPages,
        },
      },
    });
  });

  app.post<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/notifications/:id/read`,
    async (request, reply) => {
      const actor = await requireAuthenticatedUser(request, reply, authService);
      if (!actor) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      if (!idParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador de notificação inválido.",
            requestId: request.id,
          },
        });
      }

      const outcome = await notificationService.markAsRead({
        organizationId: actor.user.organizationId,
        notificationId: idParsed.data,
        recipientUserId: actor.user.id,
      });

      if (outcome.status === "NOT_FOUND") {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Notificação não encontrada.",
            requestId: request.id,
          },
        });
      }

      if (outcome.status === "FORBIDDEN") {
        return reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para marcar esta notificação como lida.",
            requestId: request.id,
          },
        });
      }

      reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Cookie, Origin");

      return reply.status(200).send({
        data: serializeNotification(outcome.notification),
      });
    },
  );
}
