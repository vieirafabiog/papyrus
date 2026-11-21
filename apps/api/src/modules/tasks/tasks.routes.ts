import {
  CONTRACTS_API_PREFIX,
  type TaskInboxQuery,
  taskInboxQuerySchema,
  uuidSchema,
} from "@docuflow/contracts";
import type { TaskInboxRepository } from "@docuflow/database";
import type { FastifyInstance } from "fastify";
import {
  type AuthenticatedAuthorizationContext,
  type DocumentAuthorizationGuard,
  buildDocumentQueryScope,
} from "../../plugins/authorization.js";

export interface TaskRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly taskInboxRepository: TaskInboxRepository;
  readonly now?: (() => Date) | undefined;
}

function collectAllowRoleIds(ctx: AuthenticatedAuthorizationContext): readonly string[] {
  const roleIds = new Set<string>();
  for (const assignment of ctx.loaded.assignments) {
    if (assignment.effect === "ALLOW") {
      roleIds.add(assignment.roleId);
    }
  }
  return Array.from(roleIds);
}

/**
 * Registers `GET /api/v1/tasks` and `GET /api/v1/tasks/:id` endpoints returning
 * authorized workflow tasks assigned to the user, their groups, or their active
 * scoped roles, filtered and paginated in PostgreSQL.
 */
export async function registerTaskRoutes(
  app: FastifyInstance,
  deps: TaskRoutesDependencies,
): Promise<void> {
  const { guard, taskInboxRepository, now } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/tasks`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const queryParsed = taskInboxQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            queryParsed.error.issues[0]?.message ??
            "Parâmetros inválidos para listagem da caixa de tarefas.",
          requestId: request.id,
        },
      });
    }

    const input: TaskInboxQuery = queryParsed.data;
    const documentScope = buildDocumentQueryScope(ctx.loaded, ctx.rolePermissions, "READ");
    const roleIds = collectAllowRoleIds(ctx);

    const result = await taskInboxRepository.listAuthorizedTasks(
      {
        organizationId: ctx.me.user.organizationId,
        userId: ctx.me.user.id,
        groupIds: ctx.loaded.groupIds,
        roleIds,
        status: input.status,
        documentId: input.documentId,
        assigneeType: input.assigneeType,
        overdueOnly: input.overdueOnly,
        page: input.page,
        pageSize: input.pageSize,
        sortBy: input.sortBy ?? "createdAt",
        sortDirection: input.sortDirection,
        referenceDate: now ? now() : new Date(),
      },
      documentScope,
    );

    reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
    reply.header("Pragma", "no-cache");
    reply.header("Vary", "Cookie, Origin");

    return reply.status(200).send({
      data: {
        items: result.items,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          totalItems: result.totalItems,
          totalPages: result.totalPages,
        },
      },
    });
  });

  app.get<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/tasks/:id`,
    async (request, reply) => {
      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      if (!idParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador de tarefa inválido.",
            requestId: request.id,
          },
        });
      }

      const documentScope = buildDocumentQueryScope(ctx.loaded, ctx.rolePermissions, "READ");
      const roleIds = collectAllowRoleIds(ctx);

      const lookup = await taskInboxRepository.findAuthorizedTaskById(
        {
          organizationId: ctx.me.user.organizationId,
          userId: ctx.me.user.id,
          groupIds: ctx.loaded.groupIds,
          roleIds,
          taskId: idParsed.data,
          referenceDate: now ? now() : new Date(),
        },
        documentScope,
      );

      if (lookup.status === "NOT_FOUND") {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Tarefa não encontrada.",
            requestId: request.id,
          },
        });
      }

      if (lookup.status === "FORBIDDEN") {
        return reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para acessar esta tarefa.",
            requestId: request.id,
          },
        });
      }

      reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Cookie, Origin");

      return reply.status(200).send({
        data: lookup.task,
      });
    },
  );
}
