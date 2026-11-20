import { randomUUID } from "node:crypto";
import {
  CONTRACTS_API_PREFIX,
  documentListQuerySchema,
  documentMetadataRecordSchema,
  isoDateSchema,
  uuidSchema,
} from "@docuflow/contracts";
import type { AuthorizationRepository } from "@docuflow/database";
import type { AuditRepositoryPort, DocumentRepositoryPort } from "@docuflow/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  buildDocumentQueryScope,
  type DocumentAuthorizationGuard,
} from "../../plugins/authorization.js";

const createDocumentBodySchema = z.object({
  title: z.string().trim().min(1).max(255),
  categoryId: uuidSchema,
  folderId: uuidSchema.nullable().default(null),
  issueDate: isoDateSchema.nullable().default(null),
  expirationDate: isoDateSchema.nullable().default(null),
  metadata: documentMetadataRecordSchema.default({}),
});

const updateDocumentBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  title: z.string().trim().min(1).max(255).optional(),
  categoryId: uuidSchema.optional(),
  folderId: uuidSchema.nullable().optional(),
  issueDate: isoDateSchema.nullable().optional(),
  expirationDate: isoDateSchema.nullable().optional(),
  metadata: documentMetadataRecordSchema.optional(),
});

export async function registerDocumentRoutes(
  app: FastifyInstance,
  deps: {
    readonly guard: DocumentAuthorizationGuard;
    readonly authzRepository: AuthorizationRepository;
    readonly documentRepository: DocumentRepositoryPort;
    readonly auditRepository: AuditRepositoryPort;
  },
): Promise<void> {
  const { guard, authzRepository, documentRepository, auditRepository } = deps;

  app.get(`${CONTRACTS_API_PREFIX}/documents`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const parsed = documentListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Parâmetros de pesquisa inválidos.",
          requestId: request.id,
        },
      });
    }

    const scope = buildDocumentQueryScope(ctx.loaded, ctx.rolePermissions, "READ");
    const result = await authzRepository.listAuthorizedDocuments(
      {
        organizationId: ctx.me.user.organizationId,
        search: parsed.data.search,
        categoryId: parsed.data.categoryId,
        folderId: parsed.data.folderId,
        status: parsed.data.status,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        sortBy: parsed.data.sortBy ?? "updatedAt",
        sortDirection: parsed.data.sortDirection,
      },
      scope,
    );

    return reply.status(200).send({
      items: result.items,
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        totalItems: result.totalItems,
        totalPages: result.totalPages,
      },
    });
  });

  app.post(`${CONTRACTS_API_PREFIX}/documents`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const parsed = createDocumentBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Dados inválidos para criação de documento.",
          requestId: request.id,
        },
      });
    }

    const allowed = await guard.authorizeCreateScope(
      ctx,
      parsed.data.categoryId,
      parsed.data.folderId,
      reply,
      request.id,
    );
    if (!allowed) {
      return reply;
    }

    const created = await documentRepository.create({
      id: randomUUID(),
      organizationId: ctx.me.user.organizationId,
      title: parsed.data.title,
      categoryId: parsed.data.categoryId,
      folderId: parsed.data.folderId,
      ownerUserId: ctx.me.user.id,
      issueDate: parsed.data.issueDate,
      expirationDate: parsed.data.expirationDate,
      metadata: parsed.data.metadata,
    });

    await auditRepository.append({
      organizationId: ctx.me.user.organizationId,
      actorUserId: ctx.me.user.id,
      action: "DOCUMENT_CREATED",
      resourceType: "DOCUMENT",
      resourceId: created.id,
      result: "SUCCESS",
      requestId: request.id,
    });

    return reply.status(201).send({ data: created });
  });

  app.get<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id`,
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

      const doc = await guard.authorizeDocument(ctx, idParsed.data, "READ", reply, request.id);
      if (!doc) {
        return reply;
      }

      return reply.status(200).send({ data: doc });
    },
  );

  app.patch<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id`,
    async (request, reply) => {
      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const bodyParsed = updateDocumentBodySchema.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador ou dados de atualização inválidos.",
            requestId: request.id,
          },
        });
      }

      const existing = await guard.authorizeDocument(
        ctx,
        idParsed.data,
        "UPDATE",
        reply,
        request.id,
      );
      if (!existing) {
        return reply;
      }

      const updated = await documentRepository.updateWithOptimisticLock(
        existing.id,
        bodyParsed.data.expectedVersion,
        {
          title: bodyParsed.data.title,
          categoryId: bodyParsed.data.categoryId,
          folderId: bodyParsed.data.folderId,
          issueDate: bodyParsed.data.issueDate,
          expirationDate: bodyParsed.data.expirationDate,
          metadata: bodyParsed.data.metadata,
        },
      );

      if (!updated) {
        return reply.status(409).send({
          error: {
            code: "DOCUMENT_VERSION_CONFLICT",
            message: "O documento foi atualizado por outra pessoa.",
            requestId: request.id,
          },
        });
      }

      await auditRepository.append({
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        action: "DOCUMENT_UPDATED",
        resourceType: "DOCUMENT",
        resourceId: updated.id,
        result: "SUCCESS",
        requestId: request.id,
      });

      return reply.status(200).send({ data: updated });
    },
  );
}
