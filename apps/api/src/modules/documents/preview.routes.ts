import { CONTRACTS_API_PREFIX, uuidSchema } from "@docuflow/contracts";
import {
  type AuditRepositoryPort,
  type DocumentVersionRepositoryPort,
  type StorageConnectionRepositoryPort,
  type UploadSessionRepositoryPort,
  isFileObjectDownloadable,
} from "@docuflow/domain";
import {
  StorageError,
  type StorageProviderRegistry,
  hasStorageCapability,
  requireSignedDownloadTargetProvider,
  resolveDownloadMode,
} from "@docuflow/storage-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DocumentAuthorizationGuard } from "../../plugins/authorization.js";

const DEFAULT_PREVIEW_SIGNED_TTL_SECONDS = 60;

const previewQuerySchema = z.object({
  versionId: uuidSchema.optional(),
  delivery: z.enum(["stream", "signed-target"]).default("stream"),
});

export interface DocumentPreviewRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly documentVersionRepository: DocumentVersionRepositoryPort;
  readonly uploadRepository: UploadSessionRepositoryPort;
  readonly storageConnections: StorageConnectionRepositoryPort;
  readonly storageRegistry: StorageProviderRegistry;
  readonly auditRepository: AuditRepositoryPort;
}

function sanitizeInlineFileName(rawName: string): string {
  const base = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (base.length === 0) {
    return "documento.pdf";
  }
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

/**
 * Registers authorized PDF preview route (`GET /api/v1/documents/:id/preview`),
 * enforcing READ scope, quarantine/rejection gates, private no-store caching headers,
 * and restrictive CSP headers on binary streams or short-lived signed targets.
 */
export async function registerDocumentPreviewRoutes(
  app: FastifyInstance,
  deps: DocumentPreviewRoutesDependencies,
): Promise<void> {
  const {
    guard,
    documentVersionRepository,
    uploadRepository,
    storageConnections,
    storageRegistry,
    auditRepository,
  } = deps;

  app.get<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/preview`,
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      const queryParsed = previewQuerySchema.safeParse(request.query);
      if (!idParsed.success || !queryParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Parâmetros inválidos para pré-visualização do documento.",
            requestId: request.id,
          },
        });
      }

      const doc = await guard.authorizeDocument(ctx, idParsed.data, "READ", reply, request.id);
      if (!doc) {
        return reply;
      }

      if (doc.status === "DELETED") {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Documento não encontrado.",
            requestId: request.id,
          },
        });
      }

      const targetVersionId = queryParsed.data.versionId ?? doc.currentVersionId;
      if (!targetVersionId) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Este documento ainda não possui versão vinculada para pré-visualização.",
            requestId: request.id,
          },
        });
      }

      const version = await documentVersionRepository.findById(targetVersionId);
      if (!version || version.documentId !== doc.id) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Versão documental não encontrada.",
            requestId: request.id,
          },
        });
      }

      if (uploadRepository.findFileObjectOrganizationId) {
        const ownerOrgId = await uploadRepository.findFileObjectOrganizationId(
          version.fileObjectId,
        );
        if (!ownerOrgId || ownerOrgId !== ctx.me.user.organizationId) {
          return reply.status(404).send({
            error: {
              code: "NOT_FOUND",
              message: "Arquivo da versão não encontrado.",
              requestId: request.id,
            },
          });
        }
      }

      const fileObject = await uploadRepository.findFileObjectById(version.fileObjectId);
      if (!fileObject) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Arquivo da versão não encontrado.",
            requestId: request.id,
          },
        });
      }

      if (!isFileObjectDownloadable(fileObject.status)) {
        const errorCode =
          fileObject.status === "QUARANTINED"
            ? "FILE_QUARANTINED"
            : fileObject.status === "REJECTED"
              ? "FILE_REJECTED"
              : "CONFLICT";
        return reply.status(409).send({
          error: {
            code: errorCode,
            message:
              "Pré-visualização bloqueada até a conclusão positiva da análise de segurança do arquivo.",
            requestId: request.id,
          },
        });
      }

      if (fileObject.detectedContentType.toLowerCase() !== "application/pdf") {
        return reply.status(415).send({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "A pré-visualização de PDF suporta apenas arquivos application/pdf.",
            requestId: request.id,
          },
        });
      }

      const connection = await storageConnections.findById(fileObject.storageConnectionId);
      if (
        !connection ||
        connection.organizationId !== ctx.me.user.organizationId ||
        connection.status !== "ACTIVE"
      ) {
        return reply.status(503).send({
          error: {
            code: "STORAGE_UNAVAILABLE",
            message: "Conexão de armazenamento indisponível para pré-visualização.",
            requestId: request.id,
          },
        });
      }

      try {
        const provider = await storageRegistry.resolveProvider(connection);

        reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
        reply.header("Pragma", "no-cache");
        reply.header("Vary", "Cookie, Origin");
        reply.header("X-Content-Type-Options", "nosniff");

        if (
          queryParsed.data.delivery === "signed-target" &&
          hasStorageCapability(provider, "signedDownload") &&
          resolveDownloadMode(provider, true) === "SIGNED_DOWNLOAD"
        ) {
          const signedProvider = requireSignedDownloadTargetProvider(provider);
          const target = await signedProvider.createSignedDownloadTarget({
            key: { value: fileObject.objectKey },
            expiresInSeconds: DEFAULT_PREVIEW_SIGNED_TTL_SECONDS,
            downloadName: sanitizeInlineFileName(fileObject.originalFileName),
          });

          await auditRepository.append({
            organizationId: ctx.me.user.organizationId,
            actorUserId: ctx.me.user.id,
            action: "DOCUMENT_PREVIEWED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: request.id,
            metadata: {
              versionId: version.id,
              fileObjectId: fileObject.id,
              delivery: "SIGNED_URL",
            },
          });

          return reply.status(200).send({
            data: {
              mode: "SIGNED_URL",
              target,
            },
          });
        }

        const downloaded = await provider.getObject({ value: fileObject.objectKey });

        await auditRepository.append({
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          action: "DOCUMENT_PREVIEWED",
          resourceType: "DOCUMENT",
          resourceId: doc.id,
          result: "SUCCESS",
          requestId: request.id,
          metadata: {
            versionId: version.id,
            fileObjectId: fileObject.id,
            delivery: "STREAM",
          },
        });

        const safeFileName = sanitizeInlineFileName(fileObject.originalFileName);
        reply.header("Content-Type", "application/pdf");
        reply.header("Content-Disposition", `inline; filename="${safeFileName}"`);
        if (downloaded.metadata.contentLength > 0) {
          reply.header("Content-Length", String(downloaded.metadata.contentLength));
        }
        reply.header(
          "Content-Security-Policy",
          "default-src 'none'; object-src 'self'; frame-ancestors 'self'",
        );
        reply.header("X-Frame-Options", "SAMEORIGIN");

        return reply.status(200).send(downloaded.body);
      } catch (error) {
        if (error instanceof StorageError) {
          return reply.status(503).send({
            error: {
              code: "STORAGE_UNAVAILABLE",
              message: error.message,
              requestId: request.id,
            },
          });
        }
        throw error;
      }
    },
  );
}
