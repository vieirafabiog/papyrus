import { randomUUID } from "node:crypto";
import { evaluateDocumentAuthorization } from "@papyrus/auth";
import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  archiveDocumentRequestSchema,
  createDocumentRequestSchema,
  createDocumentVersionRequestSchema,
  documentListQuerySchema,
  documentMetadataRecordSchema,
  isoDateSchema,
  moveDocumentRequestSchema,
  restoreDocumentVersionRequestSchema,
  restoreTrashedDocumentRequestSchema,
  trashDocumentRequestSchema,
  trashDocumentsQuerySchema,
  updateDocumentRequestSchema,
  uuidSchema,
} from "@papyrus/contracts";
import type { AuthorizationRepository, DocumentTrashRepository } from "@papyrus/database";
import {
  type ArchiveDocumentService,
  type AuditRepositoryPort,
  type CategoryFieldDefinition,
  type CategoryRepositoryPort,
  type CreateDocumentService,
  type CreateDocumentVersionService,
  type DocumentListItemEntity,
  type DocumentMetadataMap,
  type DocumentRepositoryPort,
  DomainError,
  type MoveDocumentService,
  type RestoreDocumentService,
  type TrashDocumentService,
  createAuditWriter,
  validateDocumentMetadata,
} from "@papyrus/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type DocumentAuthorizationGuard,
  buildDocumentQueryScope,
} from "../../plugins/authorization.js";

function mapCreateDocumentDomainErrorStatus(code: string): {
  status: number;
  apiCode: ErrorCode;
} {
  switch (code) {
    case "CATEGORY_NOT_FOUND":
    case "FOLDER_NOT_FOUND":
    case "OWNER_USER_NOT_FOUND":
    case "UPLOAD_SESSION_NOT_FOUND":
    case "FILE_OBJECT_NOT_FOUND":
    case "DOCUMENT_NOT_FOUND":
    case "VERSION_NOT_FOUND":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "UPLOAD_SESSION_FORBIDDEN":
      return { status: 403, apiCode: "FORBIDDEN" };
    case "FILE_ALREADY_LINKED_TO_DOCUMENT":
    case "FILE_OBJECT_NOT_AVAILABLE":
    case "INVALID_DOCUMENT_STATE":
    case "UPLOAD_NOT_FINALIZED":
    case "DOCUMENT_NOT_READY_FOR_REVIEW":
    case "CATEGORY_INACTIVE":
    case "FOLDER_ARCHIVED":
    case "VERSION_ALREADY_CURRENT":
    case "INVALID_DOCUMENT_TRANSITION":
    case "RESTORE_WINDOW_EXPIRED":
      return { status: 409, apiCode: "CONFLICT" };
    case "DOCUMENT_VERSION_CONFLICT":
      return { status: 409, apiCode: "DOCUMENT_VERSION_CONFLICT" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

function handleDocumentDomainError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    const mapped = mapCreateDocumentDomainErrorStatus(error.code);
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

const createDocumentBodySchema = z.object({
  title: z.string().trim().min(1).max(255),
  categoryId: uuidSchema,
  folderId: uuidSchema.nullable().default(null),
  issueDate: isoDateSchema.nullable().default(null),
  expirationDate: isoDateSchema.nullable().default(null),
  metadata: documentMetadataRecordSchema.default({}),
});

function toMinimalDocumentListItem(doc: {
  readonly id: string;
  readonly title: string;
  readonly categoryId: string;
  readonly folderId: string | null;
  readonly status: DocumentListItemEntity["status"];
  readonly currentVersionId: string | null;
  readonly ownerUserId: string;
  readonly issueDate: string | null;
  readonly expirationDate: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}): DocumentListItemEntity {
  return {
    id: doc.id,
    title: doc.title,
    categoryId: doc.categoryId,
    folderId: doc.folderId,
    status: doc.status,
    currentVersionId: doc.currentVersionId,
    ownerUserId: doc.ownerUserId,
    issueDate: doc.issueDate,
    expirationDate: doc.expirationDate,
    version: doc.version,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function registerDocumentRoutes(
  app: FastifyInstance,
  deps: {
    readonly guard: DocumentAuthorizationGuard;
    readonly authzRepository: AuthorizationRepository;
    readonly documentRepository: DocumentRepositoryPort;
    readonly auditRepository: AuditRepositoryPort;
    readonly categoryRepository?: CategoryRepositoryPort | undefined;
    readonly createDocumentService?: CreateDocumentService | undefined;
    readonly createDocumentVersionService?: CreateDocumentVersionService | undefined;
    readonly moveDocumentService?: MoveDocumentService | undefined;
    readonly archiveDocumentService?: ArchiveDocumentService | undefined;
    readonly trashDocumentService?: TrashDocumentService | undefined;
    readonly restoreDocumentService?: RestoreDocumentService | undefined;
    readonly documentTrashRepository?: DocumentTrashRepository | undefined;
    readonly trashNow?: (() => Date) | undefined;
  },
): Promise<void> {
  const {
    guard,
    authzRepository,
    documentRepository,
    auditRepository,
    categoryRepository,
    createDocumentService,
    createDocumentVersionService,
    moveDocumentService,
    archiveDocumentService,
    trashDocumentService,
    restoreDocumentService,
    documentTrashRepository,
    trashNow,
  } = deps;
  const auditWriter = createAuditWriter({ repository: auditRepository });

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

    // Listagem comum nunca expõe documentos enviados à lixeira lógica.
    if (parsed.data.status === "DELETED") {
      return reply.status(200).send({
        items: [],
        pagination: {
          page: parsed.data.page,
          pageSize: parsed.data.pageSize,
          totalItems: 0,
          totalPages: 0,
        },
      });
    }

    const scope = buildDocumentQueryScope(ctx.loaded, ctx.rolePermissions, "READ");
    const filter = {
      organizationId: ctx.me.user.organizationId,
      search: parsed.data.search,
      categoryId: parsed.data.categoryId,
      folderId: parsed.data.folderId,
      ownerUserId: parsed.data.ownerUserId,
      tagId: parsed.data.tagId,
      expirationFrom: parsed.data.expirationFrom,
      expirationTo: parsed.data.expirationTo,
      status: parsed.data.status,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      sortBy: parsed.data.sortBy ?? "updatedAt",
      sortDirection: parsed.data.sortDirection,
    };

    const result = authzRepository.listAuthorizedDocumentSummaries
      ? await authzRepository.listAuthorizedDocumentSummaries(filter, scope)
      : await (async () => {
          const full = await authzRepository.listAuthorizedDocuments(filter, scope);
          return {
            ...full,
            items: full.items.map(toMinimalDocumentListItem),
          };
        })();

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

    if (createDocumentService) {
      const parsedFull = createDocumentRequestSchema.safeParse(request.body);
      if (!parsedFull.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message:
              parsedFull.error.issues[0]?.message ?? "Dados inválidos para criação de documento.",
            requestId: request.id,
          },
        });
      }

      const allowed = await guard.authorizeCreateScope(
        ctx,
        parsedFull.data.categoryId,
        parsedFull.data.folderId,
        reply,
        request.id,
      );
      if (!allowed) {
        return reply;
      }

      try {
        const result = await createDocumentService.createDocument({
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          title: parsedFull.data.title,
          categoryId: parsedFull.data.categoryId,
          folderId: parsedFull.data.folderId,
          ownerUserId: parsedFull.data.ownerUserId,
          issueDate: parsedFull.data.issueDate,
          expirationDate: parsedFull.data.expirationDate,
          metadata: parsedFull.data.metadata,
          uploadSessionId: parsedFull.data.uploadSessionId,
          changeNote: parsedFull.data.changeNote,
          initialStatus: parsedFull.data.initialStatus,
        });

        return reply.status(201).send({
          data: result.document,
          initialVersion: result.initialVersion,
        });
      } catch (error) {
        return handleDocumentDomainError(error, request, reply);
      }
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
      request.ip,
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

    await auditWriter.write({
      organizationId: ctx.me.user.organizationId,
      actorUserId: ctx.me.user.id,
      action: "DOCUMENT_CREATED",
      resourceType: "DOCUMENT",
      resourceId: created.id,
      result: "SUCCESS",
      requestId: request.id,
      ipAddress: request.ip,
      metadata: {
        categoryId: created.categoryId,
        folderId: created.folderId,
      },
    });

    return reply.status(201).send({ data: created });
  });

  app.get(`${CONTRACTS_API_PREFIX}/documents/trash`, async (request, reply) => {
    if (!documentTrashRepository) {
      return reply.status(501).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Listagem da lixeira documental não configurada.",
          requestId: request.id,
        },
      });
    }

    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const parsed = trashDocumentsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            parsed.error.issues[0]?.message ?? "Parâmetros de listagem da lixeira inválidos.",
          requestId: request.id,
        },
      });
    }

    // Visualização e restauração na lixeira exige permissão DELETE efetiva no escopo.
    const scope = buildDocumentQueryScope(ctx.loaded, ctx.rolePermissions, "DELETE");
    const result = await documentTrashRepository.listAuthorizedTrash(
      {
        organizationId: ctx.me.user.organizationId,
        search: parsed.data.search,
        categoryId: parsed.data.categoryId,
        folderId: parsed.data.folderId,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        sortBy: parsed.data.sortBy,
        sortDirection: parsed.data.sortDirection,
        referenceNow: trashNow?.(),
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

      const folderAncestorIds = await authzRepository.loadFolderAncestorIds(
        ctx.me.user.organizationId,
        doc.folderId,
      );
      const scopeContext = {
        documentId: doc.id,
        categoryId: doc.categoryId,
        folderAncestorIds,
      };
      const permissions = {
        canUpdate: evaluateDocumentAuthorization(
          ctx.subject,
          "UPDATE",
          scopeContext,
          ctx.rolePermissions,
        ).allowed,
        canDelete: evaluateDocumentAuthorization(
          ctx.subject,
          "DELETE",
          scopeContext,
          ctx.rolePermissions,
        ).allowed,
        canUpload: evaluateDocumentAuthorization(
          ctx.subject,
          "UPLOAD",
          scopeContext,
          ctx.rolePermissions,
        ).allowed,
        canDownload: evaluateDocumentAuthorization(
          ctx.subject,
          "DOWNLOAD",
          scopeContext,
          ctx.rolePermissions,
        ).allowed,
      };

      const details = authzRepository.loadDocumentDetailView
        ? await authzRepository.loadDocumentDetailView(doc)
        : null;

      await auditWriter.write({
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        action: "DOCUMENT_VIEWED",
        resourceType: "DOCUMENT",
        resourceId: doc.id,
        result: "SUCCESS",
        requestId: request.id,
        ipAddress: request.ip,
        metadata: {
          status: doc.status,
          currentVersionId: doc.currentVersionId,
        },
      });

      if (!details) {
        return reply.status(200).send({
          data: {
            ...doc,
            permissions,
          },
        });
      }

      return reply.status(200).send({
        data: {
          ...doc,
          ...details,
          permissions,
        },
      });
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
      const bodyParsed = updateDocumentRequestSchema.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: bodyParsed.success
              ? "Identificador de documento inválido."
              : (bodyParsed.error.issues[0]?.message ??
                "Identificador ou dados de atualização inválidos."),
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
        request.ip,
      );
      if (!existing) {
        return reply;
      }

      const nextIssueDate =
        bodyParsed.data.issueDate !== undefined ? bodyParsed.data.issueDate : existing.issueDate;
      const nextExpirationDate =
        bodyParsed.data.expirationDate !== undefined
          ? bodyParsed.data.expirationDate
          : existing.expirationDate;
      if (
        nextIssueDate !== null &&
        nextExpirationDate !== null &&
        nextExpirationDate < nextIssueDate
      ) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "A data de vencimento não pode ser anterior à data de emissão.",
            requestId: request.id,
            details: {
              fieldErrors: {
                expirationDate: "A data de vencimento não pode ser anterior à data de emissão.",
              },
            },
          },
        });
      }

      let normalizedMetadata: DocumentMetadataMap | undefined = bodyParsed.data.metadata;
      let metadataFieldsToSync: Awaited<ReturnType<CategoryRepositoryPort["listFields"]>> = [];
      const targetCategoryId = bodyParsed.data.categoryId ?? existing.categoryId;
      if (
        categoryRepository &&
        (bodyParsed.data.metadata !== undefined || bodyParsed.data.categoryId !== undefined)
      ) {
        const fields = await categoryRepository.listFields(targetCategoryId);
        const fieldDefs: readonly CategoryFieldDefinition[] = fields.map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required,
          options: field.options ?? undefined,
        }));
        const validation = validateDocumentMetadata(
          fieldDefs,
          bodyParsed.data.metadata ?? existing.metadata,
        );
        if (!validation.valid) {
          const fieldErrors: Record<string, string> = {};
          for (const issue of validation.issues) {
            if (!fieldErrors[issue.fieldKey]) {
              fieldErrors[issue.fieldKey] = issue.reason;
            }
          }
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: "Metadados inválidos para a categoria do documento.",
              requestId: request.id,
              details: { fieldErrors },
            },
          });
        }
        normalizedMetadata = validation.normalizedMetadata;
        metadataFieldsToSync = fields;
      }

      const changedFields: string[] = [];
      if (bodyParsed.data.title !== undefined) {
        changedFields.push("title");
      }
      if (bodyParsed.data.categoryId !== undefined) {
        changedFields.push("categoryId");
      }
      if (bodyParsed.data.folderId !== undefined) {
        changedFields.push("folderId");
      }
      if (bodyParsed.data.issueDate !== undefined) {
        changedFields.push("issueDate");
      }
      if (bodyParsed.data.expirationDate !== undefined) {
        changedFields.push("expirationDate");
      }
      if (bodyParsed.data.metadata !== undefined) {
        changedFields.push("metadata");
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
          metadata: normalizedMetadata,
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

      if (
        documentRepository.syncMetadataRows &&
        metadataFieldsToSync.length > 0 &&
        normalizedMetadata
      ) {
        await documentRepository.syncMetadataRows({
          documentId: updated.id,
          fields: metadataFieldsToSync,
          metadata: normalizedMetadata,
        });
      }

      await auditWriter.write({
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        action: "DOCUMENT_UPDATED",
        resourceType: "DOCUMENT",
        resourceId: updated.id,
        result: "SUCCESS",
        requestId: request.id,
        ipAddress: request.ip,
        metadata: {
          version: updated.version,
          changedFields: changedFields.join(","),
          metadataKeyCount: normalizedMetadata ? Object.keys(normalizedMetadata).length : 0,
        },
      });

      return reply.status(200).send({ data: updated });
    },
  );

  app.get<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/versions`,
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

      const folderAncestorIds = await authzRepository.loadFolderAncestorIds(
        ctx.me.user.organizationId,
        doc.folderId,
      );
      const scopeContext = {
        documentId: doc.id,
        categoryId: doc.categoryId,
        folderAncestorIds,
      };
      const canDownloadDoc = evaluateDocumentAuthorization(
        ctx.subject,
        "DOWNLOAD",
        scopeContext,
        ctx.rolePermissions,
      ).allowed;
      const canUploadDoc = evaluateDocumentAuthorization(
        ctx.subject,
        "UPLOAD",
        scopeContext,
        ctx.rolePermissions,
      ).allowed;

      const historyRows = authzRepository.listDocumentVersionHistory
        ? await authzRepository.listDocumentVersionHistory(doc)
        : [];

      const items = historyRows.map((item) => {
        const isCurrent = item.id === doc.currentVersionId;
        const isFileAvailable = item.fileObject?.status === "AVAILABLE";
        const isEditableDocument = doc.status !== "DELETED" && doc.status !== "ARCHIVED";

        return {
          ...item,
          isCurrent,
          permissions: {
            canDownload: canDownloadDoc && isFileAvailable,
            canRestore: canUploadDoc && !isCurrent && isEditableDocument && isFileAvailable,
          },
        };
      });

      return reply.status(200).send({ data: items });
    },
  );

  app.post<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/versions`,
    async (request, reply) => {
      if (!createDocumentVersionService) {
        return reply.status(501).send({
          error: {
            code: "INTERNAL_ERROR",
            message: "Serviço de versionamento não configurado.",
            requestId: request.id,
          },
        });
      }

      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const bodyParsed = createDocumentVersionRequestSchema.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: bodyParsed.success
              ? "Identificador de documento inválido."
              : (bodyParsed.error.issues[0]?.message ??
                "Dados inválidos para criação de nova versão."),
            requestId: request.id,
          },
        });
      }

      const doc = await guard.authorizeDocument(ctx, idParsed.data, "UPLOAD", reply, request.id);
      if (!doc) {
        return reply;
      }

      try {
        const result = await createDocumentVersionService.createVersion({
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          documentId: doc.id,
          expectedVersion: bodyParsed.data.expectedVersion,
          fileObjectId: bodyParsed.data.fileObjectId,
          uploadSessionId: bodyParsed.data.uploadSessionId,
          changeNote: bodyParsed.data.changeNote,
        });

        return reply.status(201).send({
          data: result.version,
          document: result.document,
        });
      } catch (error) {
        return handleDocumentDomainError(error, request, reply);
      }
    },
  );

  app.post<{ Params: { id: string; versionId: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/versions/:versionId/restore`,
    async (request, reply) => {
      if (!createDocumentVersionService) {
        return reply.status(501).send({
          error: {
            code: "INTERNAL_ERROR",
            message: "Serviço de versionamento não configurado.",
            requestId: request.id,
          },
        });
      }

      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const versionIdParsed = uuidSchema.safeParse(request.params.versionId);
      const bodyParsed = restoreDocumentVersionRequestSchema.safeParse(request.body);
      if (!idParsed.success || !versionIdParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: !idParsed.success
              ? "Identificador de documento inválido."
              : !versionIdParsed.success
                ? "Identificador de versão inválido."
                : !bodyParsed.success
                  ? (bodyParsed.error.issues[0]?.message ??
                    "Dados inválidos para restauração de versão.")
                  : "Dados inválidos para restauração de versão.",
            requestId: request.id,
          },
        });
      }

      const doc = await guard.authorizeDocument(ctx, idParsed.data, "UPLOAD", reply, request.id);
      if (!doc) {
        return reply;
      }

      try {
        const result = await createDocumentVersionService.restoreVersion({
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          documentId: doc.id,
          targetVersionId: versionIdParsed.data,
          expectedVersion: bodyParsed.data.expectedVersion,
          changeNote: bodyParsed.data.changeNote,
        });

        return reply.status(201).send({
          data: result.version,
          document: result.document,
        });
      } catch (error) {
        return handleDocumentDomainError(error, request, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/move`,
    async (request, reply) => {
      if (!moveDocumentService) {
        return reply.status(501).send({
          error: {
            code: "INTERNAL_ERROR",
            message: "Serviço de movimentação documental não configurado.",
            requestId: request.id,
          },
        });
      }

      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const bodyParsed = moveDocumentRequestSchema.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: !idParsed.success
              ? "Identificador de documento inválido."
              : !bodyParsed.success
                ? (bodyParsed.error.issues[0]?.message ??
                  "Dados inválidos para movimentação de documento.")
                : "Dados inválidos para movimentação de documento.",
            requestId: request.id,
          },
        });
      }

      const doc = await guard.authorizeDocument(ctx, idParsed.data, "UPDATE", reply, request.id);
      if (!doc) {
        return reply;
      }

      // Valida também que o usuário pode inserir documentos na pasta de destino sem violar DENY.
      const targetAllowed = await guard.authorizeCreateScope(
        ctx,
        doc.categoryId,
        bodyParsed.data.targetFolderId,
        reply,
        request.id,
      );
      if (!targetAllowed) {
        return reply;
      }

      try {
        const updated = await moveDocumentService.moveDocument({
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          documentId: doc.id,
          expectedVersion: bodyParsed.data.expectedVersion,
          targetFolderId: bodyParsed.data.targetFolderId,
        });

        return reply.status(200).send({ data: updated });
      } catch (error) {
        return handleDocumentDomainError(error, request, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/archive`,
    async (request, reply) => {
      if (!archiveDocumentService) {
        return reply.status(501).send({
          error: {
            code: "INTERNAL_ERROR",
            message: "Serviço de arquivamento documental não configurado.",
            requestId: request.id,
          },
        });
      }

      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const bodyParsed = archiveDocumentRequestSchema.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: !idParsed.success
              ? "Identificador de documento inválido."
              : !bodyParsed.success
                ? (bodyParsed.error.issues[0]?.message ??
                  "Dados inválidos para arquivamento do documento.")
                : "Dados inválidos para arquivamento do documento.",
            requestId: request.id,
          },
        });
      }

      const doc = await guard.authorizeDocument(ctx, idParsed.data, "UPDATE", reply, request.id);
      if (!doc) {
        return reply;
      }

      try {
        const archived = await archiveDocumentService.archiveDocument({
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          documentId: doc.id,
          expectedVersion: bodyParsed.data.expectedVersion,
          reason: bodyParsed.data.reason,
        });

        return reply.status(200).send({ data: archived });
      } catch (error) {
        return handleDocumentDomainError(error, request, reply);
      }
    },
  );

  const handleTrashRequest = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    if (!trashDocumentService) {
      return reply.status(501).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Serviço de lixeira documental não configurado.",
          requestId: request.id,
        },
      });
    }

    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const idParsed = uuidSchema.safeParse(request.params.id);
    const bodyParsed = trashDocumentRequestSchema.safeParse(request.body);
    if (!idParsed.success || !bodyParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: !idParsed.success
            ? "Identificador de documento inválido."
            : !bodyParsed.success
              ? (bodyParsed.error.issues[0]?.message ??
                "Dados inválidos para envio do documento à lixeira.")
              : "Dados inválidos para envio do documento à lixeira.",
          requestId: request.id,
        },
      });
    }

    const doc = await guard.authorizeDocument(ctx, idParsed.data, "DELETE", reply, request.id);
    if (!doc) {
      return reply;
    }

    try {
      const trashed = await trashDocumentService.trashDocument({
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        requestId: request.id,
        documentId: doc.id,
        expectedVersion: bodyParsed.data.expectedVersion,
        reason: bodyParsed.data.reason,
      });

      return reply.status(200).send({ data: trashed });
    } catch (error) {
      return handleDocumentDomainError(error, request, reply);
    }
  };

  app.post<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/trash`,
    handleTrashRequest,
  );
  app.delete<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id`,
    handleTrashRequest,
  );

  app.post<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/restore`,
    async (request, reply) => {
      if (!restoreDocumentService) {
        return reply.status(501).send({
          error: {
            code: "INTERNAL_ERROR",
            message: "Serviço de restauração da lixeira não configurado.",
            requestId: request.id,
          },
        });
      }

      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const bodyParsed = restoreTrashedDocumentRequestSchema.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: !idParsed.success
              ? "Identificador de documento inválido."
              : !bodyParsed.success
                ? (bodyParsed.error.issues[0]?.message ??
                  "Dados inválidos para restauração do documento.")
                : "Dados inválidos para restauração do documento.",
            requestId: request.id,
          },
        });
      }

      const doc = await guard.authorizeDocument(
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
        const restored = await restoreDocumentService.restoreDocument({
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          documentId: doc.id,
          expectedVersion: bodyParsed.data.expectedVersion,
          targetStatus: bodyParsed.data.targetStatus,
          reason: bodyParsed.data.reason,
        });

        return reply.status(200).send({ data: restored });
      } catch (error) {
        return handleDocumentDomainError(error, request, reply);
      }
    },
  );
}
