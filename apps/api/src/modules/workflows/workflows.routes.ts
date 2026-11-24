import { evaluateAuthorization } from "@papyrus/auth";
import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  type WorkflowAssigneeCatalog,
  createWorkflowDefinitionRequestSchema,
  publishWorkflowDefinitionVersionRequestSchema,
  startDocumentWorkflowRequestSchema,
  updateWorkflowDefinitionStatusRequestSchema,
  uuidSchema,
} from "@papyrus/contracts";
import type { WorkflowTimelineRepository } from "@papyrus/database";
import {
  type AccessAction,
  type CreateWorkflowTasksService,
  DomainError,
  type StartWorkflowService,
  type WorkflowDefinitionRepositoryPort,
  type WorkflowDefinitionService,
} from "@papyrus/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AuthenticatedAuthorizationContext,
  DocumentAuthorizationGuard,
} from "../../plugins/authorization.js";

function mapWorkflowDomainErrorStatus(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "DOCUMENT_NOT_FOUND":
    case "DOCUMENT_VERSION_NOT_FOUND":
    case "FILE_OBJECT_NOT_FOUND":
    case "WORKFLOW_DEFINITION_NOT_FOUND":
    case "WORKFLOW_DEFINITION_VERSION_NOT_FOUND":
    case "WORKFLOW_ASSIGNEE_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "WORKFLOW_ASSIGNEE_UNAUTHORIZED":
      return { status: 403, apiCode: "FORBIDDEN" };
    case "WORKFLOW_ALREADY_ACTIVE":
    case "WORKFLOW_DEFINITION_INACTIVE":
    case "WORKFLOW_DEFINITION_NAME_IN_USE":
    case "WORKFLOW_DEFINITION_VERSION_CONFLICT":
    case "INVALID_DOCUMENT_TRANSITION":
    case "FILE_OBJECT_NOT_AVAILABLE":
    case "STALE_DOCUMENT_VERSION":
    case "DOCUMENT_VERSION_CONFLICT":
      return { status: 409, apiCode: "CONFLICT" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

function handleWorkflowError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    const mapped = mapWorkflowDomainErrorStatus(error.code);
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

function hasGlobalWorkflowAction(
  ctx: AuthenticatedAuthorizationContext,
  action: AccessAction,
): boolean {
  return evaluateAuthorization(
    ctx.subject,
    { action, resource: "WORKFLOW", scope: { type: "GLOBAL" } },
    ctx.rolePermissions,
  ).allowed;
}

export interface WorkflowAssigneeCatalogPort {
  listCatalog(organizationId: string): Promise<WorkflowAssigneeCatalog>;
}

export interface WorkflowRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly workflowDefinitionRepository: WorkflowDefinitionRepositoryPort;
  readonly workflowDefinitionService?: WorkflowDefinitionService | undefined;
  readonly assigneeCatalog?: WorkflowAssigneeCatalogPort | undefined;
  readonly workflowTimelineRepository?: WorkflowTimelineRepository | undefined;
  readonly startWorkflowService: StartWorkflowService;
  readonly createWorkflowTasksService: CreateWorkflowTasksService;
}

/**
 * Registers workflow definition administration (`GET/POST /api/v1/workflows/definitions`,
 * `POST /api/v1/workflows/definitions/:id/versions`, `PATCH /api/v1/workflows/definitions/:id/status`,
 * `GET /api/v1/workflows/assignees`), document workflow timeline, and workflow start endpoints
 * with server-side authorization.
 */
export async function registerWorkflowRoutes(
  app: FastifyInstance,
  deps: WorkflowRoutesDependencies,
): Promise<void> {
  const {
    guard,
    workflowDefinitionRepository,
    workflowDefinitionService,
    assigneeCatalog,
    workflowTimelineRepository,
    startWorkflowService,
    createWorkflowTasksService,
  } = deps;

  app.get<{ Querystring: { includeInactive?: string } }>(
    `${CONTRACTS_API_PREFIX}/workflows/definitions`,
    async (request, reply) => {
      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const includeInactive = request.query?.includeInactive === "true";
      const definitions = await workflowDefinitionRepository.listByOrganization(
        ctx.me.user.organizationId,
        { activeOnly: !includeInactive },
      );

      return reply.status(200).send({ data: definitions });
    },
  );

  if (assigneeCatalog) {
    app.get(`${CONTRACTS_API_PREFIX}/workflows/assignees`, async (request, reply) => {
      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const canManageOrRead =
        hasGlobalWorkflowAction(ctx, "READ") ||
        hasGlobalWorkflowAction(ctx, "CREATE") ||
        hasGlobalWorkflowAction(ctx, "UPDATE");

      if (!canManageOrRead) {
        return reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para consultar aprovadores de fluxo.",
            requestId: request.id,
          },
        });
      }

      const catalog = await assigneeCatalog.listCatalog(ctx.me.user.organizationId);
      return reply.status(200).send({ data: catalog });
    });
  }

  if (workflowDefinitionService) {
    app.get<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/workflows/definitions/:id`,
      async (request, reply) => {
        const ctx = await guard.requireSubject(request, reply);
        if (!ctx) {
          return reply;
        }

        if (!hasGlobalWorkflowAction(ctx, "READ")) {
          return reply.status(403).send({
            error: {
              code: "FORBIDDEN",
              message: "Você não possui permissão para visualizar definições de fluxo.",
              requestId: request.id,
            },
          });
        }

        const idParsed = uuidSchema.safeParse(request.params.id);
        if (!idParsed.success) {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: "Identificador de definição de fluxo inválido.",
              requestId: request.id,
            },
          });
        }

        try {
          const detail = await workflowDefinitionService.getDefinitionWithVersions(
            ctx.me.user.organizationId,
            idParsed.data,
          );
          return reply.status(200).send({ data: detail });
        } catch (error) {
          return handleWorkflowError(error, request, reply);
        }
      },
    );

    app.post(`${CONTRACTS_API_PREFIX}/workflows/definitions`, async (request, reply) => {
      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      if (!hasGlobalWorkflowAction(ctx, "CREATE")) {
        return reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para criar definições de fluxo.",
            requestId: request.id,
          },
        });
      }

      const bodyParsed = createWorkflowDefinitionRequestSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message:
              bodyParsed.error.issues[0]?.message ??
              "Dados inválidos para criação da definição de fluxo.",
            requestId: request.id,
          },
        });
      }

      try {
        const created = await workflowDefinitionService.createDefinition({
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          name: bodyParsed.data.name,
          description: bodyParsed.data.description,
          steps: bodyParsed.data.steps.map((step) => ({
            stepOrder: step.stepOrder,
            name: step.name,
            assignee: step.assignee,
            dueDays: step.dueDays ?? null,
            ...(step.commentRules ? { commentRules: step.commentRules } : {}),
          })),
        });
        return reply.status(201).send({ data: created });
      } catch (error) {
        return handleWorkflowError(error, request, reply);
      }
    });

    app.post<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/workflows/definitions/:id/versions`,
      async (request, reply) => {
        const ctx = await guard.requireSubject(request, reply);
        if (!ctx) {
          return reply;
        }

        if (!hasGlobalWorkflowAction(ctx, "UPDATE")) {
          return reply.status(403).send({
            error: {
              code: "FORBIDDEN",
              message: "Você não possui permissão para publicar novas versões de fluxo.",
              requestId: request.id,
            },
          });
        }

        const idParsed = uuidSchema.safeParse(request.params.id);
        const bodyParsed = publishWorkflowDefinitionVersionRequestSchema.safeParse(request.body);
        if (!idParsed.success || !bodyParsed.success) {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: !idParsed.success
                ? "Identificador de definição de fluxo inválido."
                : !bodyParsed.success
                  ? (bodyParsed.error.issues[0]?.message ??
                    "Dados inválidos para publicar nova versão do fluxo.")
                  : "Dados inválidos para publicar nova versão do fluxo.",
              requestId: request.id,
            },
          });
        }

        try {
          const published = await workflowDefinitionService.publishNewVersion({
            organizationId: ctx.me.user.organizationId,
            actorUserId: ctx.me.user.id,
            requestId: request.id,
            workflowDefinitionId: idParsed.data,
            steps: bodyParsed.data.steps.map((step) => ({
              stepOrder: step.stepOrder,
              name: step.name,
              assignee: step.assignee,
              dueDays: step.dueDays ?? null,
              ...(step.commentRules ? { commentRules: step.commentRules } : {}),
            })),
          });
          return reply.status(201).send({ data: published });
        } catch (error) {
          return handleWorkflowError(error, request, reply);
        }
      },
    );

    app.patch<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/workflows/definitions/:id/status`,
      async (request, reply) => {
        const ctx = await guard.requireSubject(request, reply);
        if (!ctx) {
          return reply;
        }

        if (!hasGlobalWorkflowAction(ctx, "UPDATE")) {
          return reply.status(403).send({
            error: {
              code: "FORBIDDEN",
              message: "Você não possui permissão para alterar o status de definições de fluxo.",
              requestId: request.id,
            },
          });
        }

        const idParsed = uuidSchema.safeParse(request.params.id);
        const bodyParsed = updateWorkflowDefinitionStatusRequestSchema.safeParse(request.body);
        if (!idParsed.success || !bodyParsed.success) {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: !idParsed.success
                ? "Identificador de definição de fluxo inválido."
                : "Dados inválidos para alteração de status da definição de fluxo.",
              requestId: request.id,
            },
          });
        }

        try {
          const updated = await workflowDefinitionService.setActiveStatus({
            organizationId: ctx.me.user.organizationId,
            actorUserId: ctx.me.user.id,
            requestId: request.id,
            workflowDefinitionId: idParsed.data,
            isActive: bodyParsed.data.isActive,
          });
          return reply.status(200).send({ data: updated });
        } catch (error) {
          return handleWorkflowError(error, request, reply);
        }
      },
    );
  }

  app.get<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/workflows`,
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
            message: "Identificador de documento inválido.",
            requestId: request.id,
          },
        });
      }

      const doc = await guard.authorizeDocument(
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

      const items = workflowTimelineRepository
        ? await workflowTimelineRepository.listDocumentTimeline(ctx.me.user.organizationId, doc.id)
        : [];

      return reply.status(200).send({ data: items });
    },
  );

  app.post<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/workflows`,
    async (request, reply) => {
      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const bodyParsed = startDocumentWorkflowRequestSchema.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: !idParsed.success
              ? "Identificador de documento inválido."
              : !bodyParsed.success
                ? (bodyParsed.error.issues[0]?.message ??
                  "Dados inválidos para iniciar fluxo de aprovação.")
                : "Dados inválidos para iniciar fluxo de aprovação.",
            requestId: request.id,
          },
        });
      }

      const doc = await guard.authorizeDocument(
        ctx,
        idParsed.data,
        "UPDATE",
        reply,
        request.id,
        request.ip,
      );
      if (!doc) {
        return reply;
      }

      try {
        const started = await startWorkflowService.startWorkflow({
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          documentId: doc.id,
          documentVersionId: bodyParsed.data.documentVersionId,
          workflowDefinitionId: bodyParsed.data.workflowDefinitionId,
          expectedDocumentVersion: bodyParsed.data.expectedDocumentVersion,
        });

        const generated = await createWorkflowTasksService.generateTaskForStep({
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          workflowInstanceId: started.instance.id,
          stepOrder: started.instance.currentStepOrder,
        });

        return reply.status(201).send({
          data: {
            instance: started.instance,
            task: generated.task,
            documentStatus: started.document.status,
          },
        });
      } catch (error) {
        return handleWorkflowError(error, request, reply);
      }
    },
  );
}
