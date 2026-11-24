import { CONTRACTS_API_PREFIX, uuidSchema } from "@papyrus/contracts";
import {
  type AuditRepositoryPort,
  type DocumentVersionRepositoryPort,
  type FileObjectEntity,
  type StorageConnectionRepositoryPort,
  type UploadSessionRepositoryPort,
  createAuditWriter,
  isFileObjectDownloadable,
} from "@papyrus/domain";
import {
  StorageError,
  type StorageProviderRegistry,
  hasStorageCapability,
  requireSignedDownloadTargetProvider,
  resolveDownloadMode,
} from "@papyrus/storage-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DocumentAuthorizationGuard } from "../../plugins/authorization.js";

const DEFAULT_PREVIEW_SIGNED_TTL_SECONDS = 60;
export const DEFAULT_MAX_IMAGE_PREVIEW_BYTES = 15 * 1024 * 1024;

export const ALLOWED_PREVIEW_IMAGE_MIME_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

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
  readonly maxImagePreviewBytes?: number | undefined;
}

function sanitizeInlineFileName(rawName: string, fallbackExtension = "bin"): string {
  const base = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (base.length === 0) {
    return `documento.${fallbackExtension}`;
  }
  return base;
}

function sanitizeInlinePdfFileName(rawName: string): string {
  const clean = sanitizeInlineFileName(rawName, "pdf");
  return clean.toLowerCase().endsWith(".pdf") ? clean : `${clean}.pdf`;
}

function isSupportedContentPreviewMime(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized === "application/pdf" || ALLOWED_PREVIEW_IMAGE_MIME_TYPES.has(normalized);
}

/**
 * Registers authorized PDF preview (`GET /api/v1/documents/:id/preview`) and safe inline content
 * preview (`GET /api/v1/documents/:id/content`) endpoints with READ scope checks, quarantine gates,
 * private no-store caching, and restrictive CSP headers.
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
  const maxImagePreviewBytes = deps.maxImagePreviewBytes ?? DEFAULT_MAX_IMAGE_PREVIEW_BYTES;
  const auditWriter = createAuditWriter({ repository: auditRepository });

  const authorizeAndLoadPreviewSubject = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<{
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly documentId: string;
    readonly versionId: string;
    readonly fileObject: FileObjectEntity;
    readonly delivery: "stream" | "signed-target";
  } | null> => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return null;
    }

    const idParsed = uuidSchema.safeParse(request.params.id);
    const queryParsed = previewQuerySchema.safeParse(request.query);
    if (!idParsed.success || !queryParsed.success) {
      void reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Parâmetros inválidos para pré-visualização do documento.",
          requestId: request.id,
        },
      });
      return null;
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
      return null;
    }

    if (doc.status === "DELETED") {
      void reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Documento não encontrado.",
          requestId: request.id,
        },
      });
      return null;
    }

    const targetVersionId = queryParsed.data.versionId ?? doc.currentVersionId;
    if (!targetVersionId) {
      void reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Este documento ainda não possui versão vinculada para pré-visualização.",
          requestId: request.id,
        },
      });
      return null;
    }

    const version = await documentVersionRepository.findById(targetVersionId);
    if (!version || version.documentId !== doc.id) {
      void reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Versão documental não encontrada.",
          requestId: request.id,
        },
      });
      return null;
    }

    if (uploadRepository.findFileObjectOrganizationId) {
      const ownerOrgId = await uploadRepository.findFileObjectOrganizationId(version.fileObjectId);
      if (!ownerOrgId || ownerOrgId !== ctx.me.user.organizationId) {
        void reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Arquivo da versão não encontrado.",
            requestId: request.id,
          },
        });
        return null;
      }
    }

    const fileObject = await uploadRepository.findFileObjectById(version.fileObjectId);
    if (!fileObject) {
      void reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Arquivo da versão não encontrado.",
          requestId: request.id,
        },
      });
      return null;
    }

    if (!isFileObjectDownloadable(fileObject.status)) {
      const errorCode =
        fileObject.status === "QUARANTINED"
          ? "FILE_QUARANTINED"
          : fileObject.status === "REJECTED"
            ? "FILE_REJECTED"
            : "CONFLICT";
      await auditWriter.write({
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        action: "DOCUMENT_PREVIEW_DENIED",
        resourceType: "DOCUMENT",
        resourceId: doc.id,
        result: "DENIED",
        requestId: request.id,
        ipAddress: request.ip,
        metadata: {
          versionId: version.id,
          fileObjectId: fileObject.id,
          fileStatus: fileObject.status,
          reason: errorCode,
        },
      });
      void reply.status(409).send({
        error: {
          code: errorCode,
          message:
            "Pré-visualização bloqueada até a conclusão positiva da análise de segurança do arquivo.",
          requestId: request.id,
        },
      });
      return null;
    }

    return {
      organizationId: ctx.me.user.organizationId,
      actorUserId: ctx.me.user.id,
      documentId: doc.id,
      versionId: version.id,
      fileObject,
      delivery: queryParsed.data.delivery,
    };
  };

  const deliverPreviewResponse = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    subject: {
      readonly organizationId: string;
      readonly actorUserId: string;
      readonly documentId: string;
      readonly versionId: string;
      readonly fileObject: FileObjectEntity;
      readonly delivery: "stream" | "signed-target";
    },
    contentType: string,
    inlineFileName: string,
  ): Promise<FastifyReply> => {
    const { organizationId, actorUserId, documentId, versionId, fileObject, delivery } = subject;
    const connection = await storageConnections.findById(fileObject.storageConnectionId);
    if (
      !connection ||
      connection.organizationId !== organizationId ||
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
        delivery === "signed-target" &&
        hasStorageCapability(provider, "signedDownload") &&
        resolveDownloadMode(provider, true) === "SIGNED_DOWNLOAD"
      ) {
        const signedProvider = requireSignedDownloadTargetProvider(provider);
        const target = await signedProvider.createSignedDownloadTarget({
          key: { value: fileObject.objectKey },
          expiresInSeconds: DEFAULT_PREVIEW_SIGNED_TTL_SECONDS,
          downloadName: inlineFileName,
        });

        await auditWriter.write({
          organizationId,
          actorUserId,
          action: "DOCUMENT_PREVIEWED",
          resourceType: "DOCUMENT",
          resourceId: documentId,
          result: "SUCCESS",
          requestId: request.id,
          ipAddress: request.ip,
          metadata: {
            versionId,
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

      await auditWriter.write({
        organizationId,
        actorUserId,
        action: "DOCUMENT_PREVIEWED",
        resourceType: "DOCUMENT",
        resourceId: documentId,
        result: "SUCCESS",
        requestId: request.id,
        ipAddress: request.ip,
        metadata: {
          versionId,
          fileObjectId: fileObject.id,
          delivery: "STREAM",
        },
      });

      reply.header("Content-Type", contentType);
      reply.header("Content-Disposition", `inline; filename="${inlineFileName}"`);
      if (downloaded.metadata.contentLength > 0) {
        reply.header("Content-Length", String(downloaded.metadata.contentLength));
      }
      reply.header(
        "Content-Security-Policy",
        "default-src 'none'; img-src 'self'; object-src 'self'; frame-ancestors 'self'",
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
  };

  app.get<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/preview`,
    async (request, reply) => {
      const subject = await authorizeAndLoadPreviewSubject(request, reply);
      if (!subject) {
        return reply;
      }

      if (subject.fileObject.detectedContentType.toLowerCase() !== "application/pdf") {
        return reply.status(415).send({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "A pré-visualização de PDF suporta apenas arquivos application/pdf.",
            requestId: request.id,
          },
        });
      }

      return deliverPreviewResponse(
        request,
        reply,
        subject,
        "application/pdf",
        sanitizeInlinePdfFileName(subject.fileObject.originalFileName),
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/content`,
    async (request, reply) => {
      const subject = await authorizeAndLoadPreviewSubject(request, reply);
      if (!subject) {
        return reply;
      }

      const detectedMime = subject.fileObject.detectedContentType.toLowerCase();
      if (!isSupportedContentPreviewMime(detectedMime)) {
        return reply.status(415).send({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message:
              "Este formato não possui pré-visualização segura no navegador. Utilize a opção de download autorizado.",
            requestId: request.id,
          },
        });
      }

      if (
        ALLOWED_PREVIEW_IMAGE_MIME_TYPES.has(detectedMime) &&
        subject.fileObject.sizeBytes > maxImagePreviewBytes
      ) {
        return reply.status(413).send({
          error: {
            code: "UPLOAD_TOO_LARGE",
            message:
              "A imagem excede o limite de tamanho para pré-visualização inline. Realize o download autorizado.",
            requestId: request.id,
          },
        });
      }

      return deliverPreviewResponse(
        request,
        reply,
        subject,
        detectedMime,
        sanitizeInlineFileName(subject.fileObject.originalFileName),
      );
    },
  );
}
