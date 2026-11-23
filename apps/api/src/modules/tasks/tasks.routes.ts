import {
  CONTRACTS_API_PREFIX,
  type TaskInboxQuery,
  taskInboxQuerySchema,
  uuidSchema,
} from "@docuflow/contracts";
import type { TaskInboxRepository } from "@docuflow/database";
import {
  type CreateWorkflowTasksService,
  type DecideTaskService,
  DomainError,
} from "@docuflow/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  type AuthenticatedAuthorizationContext,
  type DocumentAuthorizationGuard,
  buildDocumentQueryScope,
} from "../../plugins/authorization.js";

const decideTaskActionSchema = z.enum(["APPROVE", "REJECT", "REQUEST_CHANGES", "CANCEL"]);

const decideTaskBodySchema = z
  .object({
    action: decideTaskActionSchema.optional(),
    decision: decideTaskActionSchema.optional(),
    comment: z.string().max(2000).nullable().optional(),
  })
  .refine((body) => body.action !== undefined || body.decision !== undefined, {
    message: "Informe a decisão ou ação para a tarefa.",
  });

function mapDecideTaskDomainErrorStatus(code: string): {
  status: number;
  apiCode: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "VALIDATION_ERROR";
} {
  switch (code) {
    case "TASK_NOT_FOUND":
    case "WORKFLOW_INSTANCE_NOT_FOUND":
    case "DOCUMENT_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "TASK_DECISION_FORBIDDEN":
      return { status: 403, apiCode: "FORBIDDEN" };
    case "TASK_ALREADY_TERMINAL":
    case "WORKFLOW_INSTANCE_NOT_ACTIVE":
    case "VERSION_LOCK_MISMATCH":
    case "INVALID_DOCUMENT_TRANSITION":
      return { status: 409, apiCode: "CONFLICT" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

export interface TaskRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly taskInboxRepository: TaskInboxRepository;
  readonly decideTaskService?: DecideTaskService | undefined;
  readonly createWorkflowTasksService?: CreateWorkflowTasksService | undefined;
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
  const { guard, taskInboxRepository, decideTaskService, createWorkflowTasksService, now } = deps;

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

  if (decideTaskService) {
    app.post<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/tasks/:id/decision`,
      async (request, reply) => {
        const ctx = await guard.requireSubject(request, reply);
        if (!ctx) {
          return reply;
        }

        const idParsed = uuidSchema.safeParse(request.params.id);
        const bodyParsed = decideTaskBodySchema.safeParse(request.body);
        if (!idParsed.success || !bodyParsed.success) {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: "Parâmetros inválidos para decisão na tarefa de workflow.",
              requestId: request.id,
            },
          });
        }

        try {
          const resolvedAction = bodyParsed.data.decision ?? bodyParsed.data.action;
          if (!resolvedAction) {
            return reply.status(400).send({
              error: {
                code: "VALIDATION_ERROR",
                message: "Parâmetros inválidos para decisão na tarefa de workflow.",
                requestId: request.id,
              },
            });
          }

          const rawIdempotencyKey = request.headers["idempotency-key"];
          const decided = await decideTaskService.decideTask({
            organizationId: ctx.me.user.organizationId,
            actorUserId: ctx.me.user.id,
            actorGroupIds: ctx.loaded.groupIds,
            actorRoleIds: collectAllowRoleIds(ctx),
            requestId: request.id,
            taskId: idParsed.data,
            action: resolvedAction,
            comment: bodyParsed.data.comment ?? null,
            ...(typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim().length > 0
              ? { idempotencyKey: rawIdempotencyKey.trim() }
              : {}),
          });

          if (!decided.idempotentReplay && decided.nextStep && createWorkflowTasksService) {
            await createWorkflowTasksService.generateTaskForStep({
              organizationId: ctx.me.user.organizationId,
              actorUserId: ctx.me.user.id,
              requestId: request.id,
              workflowInstanceId: decided.instance.id,
              stepOrder: decided.nextStep.stepOrder,
            });
          }

          return reply.status(200).send({
            data: {
              ...decided,
              documentStatus: decided.document.status,
            },
          });
        } catch (error) {
          if (error instanceof DomainError) {
            const mapped = mapDecideTaskDomainErrorStatus(error.code);
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
}
