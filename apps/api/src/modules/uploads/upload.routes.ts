import {
  CONTRACTS_API_PREFIX,
  createUploadSessionRequestSchema,
  type UploadSessionRecordContract,
  uuidSchema,
} from "@docuflow/contracts";
import {
  DomainError,
  type UploadSessionRepositoryPort,
  type UploadSessionService,
} from "@docuflow/domain";
import type { FastifyInstance } from "fastify";
import type { DocumentAuthorizationGuard } from "../../plugins/authorization.js";

function mapUploadDomainError(code: string): { status: number; httpCode: string } {
  switch (code) {
    case "UPLOAD_TOO_LARGE":
      return { status: 413, httpCode: "UPLOAD_TOO_LARGE" };
    case "IDEMPOTENCY_CONFLICT":
      return { status: 409, httpCode: "CONFLICT" };
    case "DOCUMENT_NOT_FOUND":
    case "STORAGE_CONNECTION_NOT_FOUND":
      return { status: 404, httpCode: "NOT_FOUND" };
    case "STORAGE_CONNECTION_INACTIVE":
      return { status: 503, httpCode: "STORAGE_UNAVAILABLE" };
    default:
      return { status: 400, httpCode: "VALIDATION_ERROR" };
  }
}

export async function registerUploadRoutes(
  app: FastifyInstance,
  deps: {
    readonly guard: DocumentAuthorizationGuard;
    readonly uploadSessionService: UploadSessionService;
    readonly uploadRepository: UploadSessionRepositoryPort;
  },
): Promise<void> {
  const { guard, uploadSessionService, uploadRepository } = deps;

  app.post(`${CONTRACTS_API_PREFIX}/uploads/sessions`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const headerKey = request.headers["idempotency-key"];
    const bodyObject =
      typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const mergedBody =
      typeof headerKey === "string" && bodyObject.idempotencyKey === undefined
        ? { ...bodyObject, idempotencyKey: headerKey }
        : request.body;

    const parsed = createUploadSessionRequestSchema.safeParse(mergedBody);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Dados inválidos para criação da sessão de upload.",
          requestId: request.id,
        },
      });
    }

    const data = parsed.data;
    if (data.documentId) {
      const authorizedDoc = await guard.authorizeDocument(
        ctx,
        data.documentId,
        "UPLOAD",
        reply,
        request.id,
      );
      if (!authorizedDoc) {
        return reply;
      }
    } else {
      const allowed = await guard.authorizeUploadScope(
        ctx,
        data.categoryId ?? null,
        data.folderId ?? null,
        reply,
        request.id,
      );
      if (!allowed) {
        return reply;
      }
    }

    try {
      const result = await uploadSessionService.createSession({
        organizationId: ctx.me.user.organizationId,
        userId: ctx.me.user.id,
        requestId: request.id,
        documentId: data.documentId,
        categoryId: data.categoryId,
        storageConnectionId: data.storageConnectionId,
        originalFileName: data.originalFileName,
        declaredSizeBytes: data.declaredSizeBytes,
        declaredContentType: data.declaredContentType,
        declaredChecksumSha256: data.declaredChecksumSha256,
        idempotencyKey: data.idempotencyKey,
        expiresInSeconds: data.expiresInSeconds,
      });

      const responseData: UploadSessionRecordContract = {
        ...result.session,
        objectKey: result.fileObject.objectKey,
      };

      return reply.status(result.idempotentReplay ? 200 : 201).send({
        data: responseData,
      });
    } catch (error) {
      if (error instanceof DomainError) {
        const mapped = mapUploadDomainError(error.code);
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

  app.get<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/uploads/sessions/:id`,
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
            message: "Identificador de sessão de upload inválido.",
            requestId: request.id,
          },
        });
      }

      const session = await uploadRepository.findById(idParsed.data);
      if (
        !session ||
        session.organizationId !== ctx.me.user.organizationId ||
        session.userId !== ctx.me.user.id
      ) {
        return reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para consultar esta sessão de upload.",
            requestId: request.id,
          },
        });
      }

      const fileObject = await uploadRepository.findFileObjectById(session.fileObjectId);
      if (!fileObject) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Objeto vinculado à sessão de upload não foi encontrado.",
            requestId: request.id,
          },
        });
      }

      const responseData: UploadSessionRecordContract = {
        ...session,
        objectKey: fileObject.objectKey,
      };
      return reply.status(200).send({ data: responseData });
    },
  );
}
