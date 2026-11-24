import { CONTRACTS_API_PREFIX, uuidSchema } from "@papyrus/contracts";
import {
  type AuditRepositoryPort,
  type DocumentVersionRepositoryPort,
  type FileObjectEntity,
  type StorageConnectionEntity,
  type StorageConnectionRepositoryPort,
  type UploadSessionRepositoryPort,
  createAuditWriter,
  isFileObjectDownloadable,
} from "@papyrus/domain";
import {
  StorageError,
  type StorageProvider,
  type StorageProviderRegistry,
  assertStorageCapability,
  requireSignedDownloadTargetProvider,
  resolveDownloadMode,
} from "@papyrus/storage-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DocumentAuthorizationGuard } from "../../plugins/authorization.js";

export const DEFAULT_DOWNLOAD_SIGNED_TTL_SECONDS = 60;
export const MIN_DOWNLOAD_SIGNED_TTL_SECONDS = 15;
export const MAX_DOWNLOAD_SIGNED_TTL_SECONDS = 120;

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;
const ALL_ZERO_SHA256 = "0".repeat(64);

const downloadTargetBodySchema = z
  .object({
    versionId: uuidSchema.optional(),
    preferSigned: z.boolean().default(true),
    expiresInSeconds: z
      .number()
      .int("A validade da URL de download deve ser um número inteiro em segundos.")
      .min(
        MIN_DOWNLOAD_SIGNED_TTL_SECONDS,
        `A validade mínima da URL assinada é de ${MIN_DOWNLOAD_SIGNED_TTL_SECONDS} segundos.`,
      )
      .max(
        MAX_DOWNLOAD_SIGNED_TTL_SECONDS,
        `A validade máxima da URL assinada é de ${MAX_DOWNLOAD_SIGNED_TTL_SECONDS} segundos.`,
      )
      .default(DEFAULT_DOWNLOAD_SIGNED_TTL_SECONDS),
  })
  .default({});

const downloadStreamQuerySchema = z.object({
  versionId: uuidSchema.optional(),
});

export interface DocumentDownloadRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly documentVersionRepository: DocumentVersionRepositoryPort;
  readonly uploadRepository: UploadSessionRepositoryPort;
  readonly storageConnections: StorageConnectionRepositoryPort;
  readonly storageRegistry: StorageProviderRegistry;
  readonly auditRepository: AuditRepositoryPort;
}

interface AuthorizedDownloadSubject {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly fileObject: FileObjectEntity;
  readonly connection: StorageConnectionEntity;
  readonly provider: StorageProvider;
  readonly safeFileName: string;
}

/**
 * Strips path segments, control characters, quotes, and unsafe symbols so
 * untrusted filenames cannot inject headers or perform path traversal.
 */
export function sanitizeDownloadFileName(rawName: string): string {
  const withoutControls = rawName.replace(/[\r\n\t\0]/g, "");
  const segments = withoutControls.split(/[/\\]/);
  const lastSegment = segments[segments.length - 1] ?? "";
  const cleaned = lastSegment
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);

  return cleaned.length > 0 ? cleaned : "documento";
}

function mapStorageErrorResponse(
  error: StorageError,
  requestId: string,
  reply: FastifyReply,
): FastifyReply {
  if (error.code === "NOT_FOUND") {
    return reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Objeto binário não encontrado no provedor de armazenamento.",
        requestId,
      },
    });
  }

  if (error.code === "CHECKSUM_MISMATCH") {
    return reply.status(409).send({
      error: {
        code: "CONFLICT",
        message: "Falha de integridade: checksum do objeto armazenado diverge do registrado.",
        requestId,
      },
    });
  }

  if (error.code === "CAPABILITY_NOT_SUPPORTED") {
    return reply.status(501).send({
      error: {
        code: "STORAGE_UNAVAILABLE",
        message: error.message,
        requestId,
      },
    });
  }

  return reply.status(503).send({
    error: {
      code: "STORAGE_UNAVAILABLE",
      message: error.message,
      requestId,
    },
  });
}

function setPrivateNoCacheHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Cookie, Origin");
  reply.header("X-Content-Type-Options", "nosniff");
}

/**
 * Registers authorized document download endpoints:
 * - `POST /api/v1/documents/:id/download-target` (short-lived signed URL or API streaming target)
 * - `GET /api/v1/documents/:id/download` (authenticated, authorized streaming download)
 */
export async function registerDocumentDownloadRoutes(
  app: FastifyInstance,
  deps: DocumentDownloadRoutesDependencies,
): Promise<void> {
  const {
    guard,
    documentVersionRepository,
    uploadRepository,
    storageConnections,
    storageRegistry,
    auditRepository,
  } = deps;
  const auditWriter = createAuditWriter({ repository: auditRepository });

  const authorizeAndResolveDownload = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    requestedVersionId: string | undefined,
  ): Promise<AuthorizedDownloadSubject | null> => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return null;
    }

    const idParsed = uuidSchema.safeParse(request.params.id);
    if (!idParsed.success) {
      void reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Identificador de documento inválido para download.",
          requestId: request.id,
        },
      });
      return null;
    }

    const doc = await guard.authorizeDocument(
      ctx,
      idParsed.data,
      "DOWNLOAD",
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

    const targetVersionId = requestedVersionId ?? doc.currentVersionId;
    if (!targetVersionId) {
      void reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Este documento ainda não possui versão vinculada para download.",
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
        action: "DOCUMENT_DOWNLOAD_DENIED",
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
            fileObject.status === "QUARANTINED"
              ? "Download bloqueado enquanto o arquivo estiver em análise de segurança."
              : fileObject.status === "REJECTED"
                ? "Download bloqueado porque o arquivo foi rejeitado na verificação de segurança."
                : "O arquivo ainda não está disponível para download.",
          requestId: request.id,
        },
      });
      return null;
    }

    const connection = await storageConnections.findById(fileObject.storageConnectionId);
    if (
      !connection ||
      connection.organizationId !== ctx.me.user.organizationId ||
      connection.status !== "ACTIVE"
    ) {
      void reply.status(503).send({
        error: {
          code: "STORAGE_UNAVAILABLE",
          message: "Conexão de armazenamento indisponível para realizar o download.",
          requestId: request.id,
        },
      });
      return null;
    }

    try {
      const provider = await storageRegistry.resolveProvider(connection);
      return {
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        documentId: doc.id,
        versionId: version.id,
        fileObject,
        connection,
        provider,
        safeFileName: sanitizeDownloadFileName(fileObject.originalFileName),
      };
    } catch (error) {
      if (error instanceof StorageError) {
        mapStorageErrorResponse(error, request.id, reply);
        return null;
      }
      throw error;
    }
  };

  app.post<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/download-target`,
    async (request, reply) => {
      const bodyParsed = downloadTargetBodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message:
              bodyParsed.error.issues[0]?.message ??
              "Parâmetros inválidos para solicitação de download.",
            requestId: request.id,
          },
        });
      }

      const subject = await authorizeAndResolveDownload(request, reply, bodyParsed.data.versionId);
      if (!subject) {
        return reply;
      }

      const {
        organizationId,
        actorUserId,
        documentId,
        versionId,
        fileObject,
        connection,
        provider,
        safeFileName,
      } = subject;

      try {
        setPrivateNoCacheHeaders(reply);
        const mode = resolveDownloadMode(provider, bodyParsed.data.preferSigned);

        if (mode === "SIGNED_DOWNLOAD") {
          const signedProvider = requireSignedDownloadTargetProvider(provider);
          const target = await signedProvider.createSignedDownloadTarget({
            key: { value: fileObject.objectKey },
            expiresInSeconds: bodyParsed.data.expiresInSeconds,
            downloadName: safeFileName,
          });

          await auditWriter.write({
            organizationId,
            actorUserId,
            action: "DOCUMENT_DOWNLOADED",
            resourceType: "DOCUMENT",
            resourceId: documentId,
            result: "SUCCESS",
            requestId: request.id,
            ipAddress: request.ip,
            metadata: {
              versionId,
              fileObjectId: fileObject.id,
              storageConnectionId: connection.id,
              delivery: "SIGNED_URL",
              expiresInSeconds: bodyParsed.data.expiresInSeconds,
            },
          });

          const expiresAtIso = target.expiresAt.toISOString();
          return reply.status(200).send({
            data: {
              mode: "SIGNED_URL",
              url: target.url,
              expiresAt: expiresAtIso,
              fileName: safeFileName,
              contentType: fileObject.detectedContentType,
              sizeBytes: fileObject.sizeBytes,
              checksumSha256: fileObject.checksumSha256,
              target: {
                url: target.url,
                method: target.method,
                headers: target.headers,
                expiresAt: expiresAtIso,
              },
            },
          });
        }

        const streamPath = `${CONTRACTS_API_PREFIX}/documents/${documentId}/download?versionId=${encodeURIComponent(versionId)}`;

        await auditWriter.write({
          organizationId,
          actorUserId,
          action: "DOCUMENT_DOWNLOAD_REQUESTED",
          resourceType: "DOCUMENT",
          resourceId: documentId,
          result: "SUCCESS",
          requestId: request.id,
          ipAddress: request.ip,
          metadata: {
            versionId,
            fileObjectId: fileObject.id,
            storageConnectionId: connection.id,
            delivery: "API_STREAMING",
          },
        });

        return reply.status(200).send({
          data: {
            mode: "API_STREAMING",
            url: streamPath,
            expiresAt: null,
            fileName: safeFileName,
            contentType: fileObject.detectedContentType,
            sizeBytes: fileObject.sizeBytes,
            checksumSha256: fileObject.checksumSha256,
          },
        });
      } catch (error) {
        if (error instanceof StorageError) {
          return mapStorageErrorResponse(error, request.id, reply);
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    `${CONTRACTS_API_PREFIX}/documents/:id/download`,
    async (request, reply) => {
      const queryParsed = downloadStreamQuerySchema.safeParse(request.query);
      if (!queryParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Parâmetros inválidos para download do documento.",
            requestId: request.id,
          },
        });
      }

      const subject = await authorizeAndResolveDownload(request, reply, queryParsed.data.versionId);
      if (!subject) {
        return reply;
      }

      const {
        organizationId,
        actorUserId,
        documentId,
        versionId,
        fileObject,
        connection,
        provider,
        safeFileName,
      } = subject;

      try {
        assertStorageCapability(provider, "streamingRead");
        const downloaded = await provider.getObject({ value: fileObject.objectKey });

        const returnedChecksum = downloaded.metadata.checksumSha256.trim().toLowerCase();
        if (
          SHA256_HEX_REGEX.test(returnedChecksum) &&
          returnedChecksum !== ALL_ZERO_SHA256 &&
          returnedChecksum !== fileObject.checksumSha256.toLowerCase()
        ) {
          downloaded.body.destroy();
          await auditWriter.write({
            organizationId,
            actorUserId,
            action: "DOCUMENT_DOWNLOAD_FAILED",
            resourceType: "DOCUMENT",
            resourceId: documentId,
            result: "FAILURE",
            requestId: request.id,
            ipAddress: request.ip,
            metadata: {
              versionId,
              fileObjectId: fileObject.id,
              reason: "CHECKSUM_MISMATCH",
            },
          });
          return reply.status(409).send({
            error: {
              code: "CONFLICT",
              message: "Falha de integridade ao ler o arquivo no armazenamento.",
              requestId: request.id,
            },
          });
        }

        await auditWriter.write({
          organizationId,
          actorUserId,
          action: "DOCUMENT_DOWNLOADED",
          resourceType: "DOCUMENT",
          resourceId: documentId,
          result: "SUCCESS",
          requestId: request.id,
          ipAddress: request.ip,
          metadata: {
            versionId,
            fileObjectId: fileObject.id,
            storageConnectionId: connection.id,
            delivery: "STREAM",
          },
        });

        setPrivateNoCacheHeaders(reply);
        reply.header("Content-Type", fileObject.detectedContentType);
        reply.header("Content-Disposition", `attachment; filename="${safeFileName}"`);
        reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
        if (downloaded.metadata.contentLength > 0) {
          reply.header("Content-Length", String(downloaded.metadata.contentLength));
        }

        return reply.status(200).send(downloaded.body);
      } catch (error) {
        if (error instanceof StorageError) {
          return mapStorageErrorResponse(error, request.id, reply);
        }
        throw error;
      }
    },
  );
}
