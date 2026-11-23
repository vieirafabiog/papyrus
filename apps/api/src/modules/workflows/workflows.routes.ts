import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  startDocumentWorkflowRequestSchema,
  uuidSchema,
} from "@docuflow/contracts";
import type { WorkflowTimelineRepository } from "@docuflow/database";
import {
  type CreateWorkflowTasksService,
  DomainError,
  type StartWorkflowService,
  type WorkflowDefinitionRepositoryPort,
} from "@docuflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DocumentAuthorizationGuard } from "../../plugins/authorization.js";

function mapWorkflowDomainErrorStatus(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "DOCUMENT_NOT_FOUND":
    case "DOCUMENT_VERSION_NOT_FOUND":
    case "FILE_OBJECT_NOT_FOUND":
    case "WORKFLOW_DEFINITION_NOT_FOUND":
    case "WORKFLOW_DEFINITION_VERSION_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "WORKFLOW_ASSIGNEE_UNAUTHORIZED":
      return { status: 403, apiCode: "FORBIDDEN" };
    case "WORKFLOW_ALREADY_ACTIVE":
    case "WORKFLOW_DEFINITION_INACTIVE":
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

export interface WorkflowRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly workflowDefinitionRepository: WorkflowDefinitionRepositoryPort;
  readonly workflowTimelineRepository?: WorkflowTimelineRepository | undefined;
  readonly startWorkflowService: StartWorkflowService;
  readonly createWorkflowTasksService: CreateWorkflowTasksService;
}

/**
 * Registers workflow definition listing (`GET /api/v1/workflows/definitions`),
 * document workflow timeline (`GET /api/v1/documents/:id/workflows`), and workflow
 * start (`POST /api/v1/documents/:id/workflows`) with server-side authorization.
 */
export async function registerWorkflowRoutes(
  app: FastifyInstance,
  deps: WorkflowRoutesDependencies,
): Promise<void> {
  const {
    guard,
    workflowDefinitionRepository,
    workflowTimelineRepository,
    startWorkflowService,
    createWorkflowTasksService,
  } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/workflows/definitions`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const definitions = await workflowDefinitionRepository.listByOrganization(
      ctx.me.user.organizationId,
      { activeOnly: true },
    );

    return reply.status(200).send({ data: definitions });
  });

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
