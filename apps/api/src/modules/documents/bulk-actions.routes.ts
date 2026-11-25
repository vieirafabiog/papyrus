import type { Readable } from "node:stream";
import {
  type BulkDocumentActionItemResult,
  CONTRACTS_API_PREFIX,
  bulkDocumentActionRequestSchema,
  bulkDocumentDownloadRequestSchema,
} from "@papyrus/contracts";
import {
  type ArchiveDocumentService,
  type AuditRepositoryPort,
  type DocumentVersionRepositoryPort,
  DomainError,
  type MoveDocumentService,
  type StorageConnectionRepositoryPort,
  type TagService,
  type TrashDocumentService,
  type UploadSessionRepositoryPort,
  createAuditWriter,
  isFileObjectDownloadable,
} from "@papyrus/domain";
import { StorageError, type StorageProviderRegistry } from "@papyrus/storage-core";
import type { FastifyInstance } from "fastify";
import { zipSync } from "fflate";
import type { DocumentAuthorizationGuard } from "../../plugins/authorization.js";
import { sanitizeDownloadFileName } from "./download.routes.js";

export const DEFAULT_MAX_BULK_ZIP_TOTAL_BYTES = 100 * 1024 * 1024;

export interface DocumentBulkActionRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly moveDocumentService?: MoveDocumentService | undefined;
  readonly archiveDocumentService?: ArchiveDocumentService | undefined;
  readonly trashDocumentService?: TrashDocumentService | undefined;
  readonly tagService?: TagService | undefined;
  readonly documentVersionRepository?: DocumentVersionRepositoryPort | undefined;
  readonly uploadRepository?: UploadSessionRepositoryPort | undefined;
  readonly storageConnections?: StorageConnectionRepositoryPort | undefined;
  readonly storageRegistry?: StorageProviderRegistry | undefined;
  readonly auditRepository: AuditRepositoryPort;
  readonly maxBulkZipTotalBytes?: number | undefined;
}

function makeUniqueArchiveFileName(rawName: string, usedNames: Set<string>): string {
  const baseSafe = sanitizeDownloadFileName(rawName);
  if (!usedNames.has(baseSafe.toLowerCase())) {
    usedNames.add(baseSafe.toLowerCase());
    return baseSafe;
  }

  const dotIdx = baseSafe.lastIndexOf(".");
  const stem = dotIdx > 0 ? baseSafe.slice(0, dotIdx) : baseSafe;
  const ext = dotIdx > 0 ? baseSafe.slice(dotIdx) : "";

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${stem} (${suffix})${ext}`.slice(0, 130);
    if (!usedNames.has(candidate.toLowerCase())) {
      usedNames.add(candidate.toLowerCase());
      return candidate;
    }
  }

  const fallback = `${stem}-${usedNames.size + 1}${ext}`;
  usedNames.add(fallback.toLowerCase());
  return fallback;
}

async function readStreamToBufferBounded(
  stream: Readable,
  maxRemainingBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxRemainingBytes) {
      stream.destroy();
      throw new DomainError(
        "BULK_ZIP_TOO_LARGE",
        "O volume selecionado excede o limite máximo suportado para download em arquivo compactado.",
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Registers bulk document operations (`POST /api/v1/documents/bulk-actions`) and
 * server-authorized ZIP archive downloads (`POST /api/v1/documents/bulk-download`),
 * enforcing per-document scope checks, quarantine gates, retention holds, and audit trails.
 */
export async function registerDocumentBulkActionRoutes(
  app: FastifyInstance,
  deps: DocumentBulkActionRoutesDependencies,
): Promise<void> {
  const {
    guard,
    moveDocumentService,
    archiveDocumentService,
    trashDocumentService,
    tagService,
    documentVersionRepository,
    uploadRepository,
    storageConnections,
    storageRegistry,
    auditRepository,
  } = deps;
  const maxBulkZipTotalBytes = deps.maxBulkZipTotalBytes ?? DEFAULT_MAX_BULK_ZIP_TOTAL_BYTES;
  const auditWriter = createAuditWriter({ repository: auditRepository });

  app.post(`${CONTRACTS_API_PREFIX}/documents/bulk-actions`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const parsed = bulkDocumentActionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Dados inválidos para ação em lote.",
          requestId: request.id,
        },
      });
    }

    const payload = parsed.data;
    const uniqueDocIds = Array.from(new Set(payload.documentIds));
    const requiredAction = payload.action === "TRASH" ? "DELETE" : "UPDATE";

    if (payload.action === "MOVE" && !moveDocumentService) {
      return reply.status(501).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Serviço de movimentação documental não configurado.",
          requestId: request.id,
        },
      });
    }
    if (payload.action === "ARCHIVE" && !archiveDocumentService) {
      return reply.status(501).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Serviço de arquivamento documental não configurado.",
          requestId: request.id,
        },
      });
    }
    if (payload.action === "TRASH" && !trashDocumentService) {
      return reply.status(501).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Serviço de lixeira documental não configurado.",
          requestId: request.id,
        },
      });
    }
    if (payload.action === "ATTACH_TAG" && !tagService) {
      return reply.status(501).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Serviço de etiquetas não configurado.",
          requestId: request.id,
        },
      });
    }

    const results: BulkDocumentActionItemResult[] = [];
    let succeededCount = 0;
    let failedCount = 0;

    for (const documentId of uniqueDocIds) {
      const access = await guard.inspectDocument(
        ctx,
        documentId,
        requiredAction,
        request.id,
        request.ip,
      );
      if (!access.allowed) {
        failedCount += 1;
        results.push({
          documentId,
          status: "FAILED",
          errorCode: access.code,
          message: access.message,
        });
        continue;
      }

      const doc = access.document;
      try {
        switch (payload.action) {
          case "MOVE": {
            if (doc.folderId !== payload.targetFolderId) {
              const targetAllowed = await guard.inspectCreateScope(
                ctx,
                doc.categoryId,
                payload.targetFolderId,
                request.id,
                request.ip,
              );
              if (!targetAllowed) {
                failedCount += 1;
                results.push({
                  documentId,
                  status: "FAILED",
                  errorCode: "FORBIDDEN",
                  message:
                    "Você não possui permissão para mover documentos para a pasta selecionada.",
                });
                continue;
              }
              await moveDocumentService?.moveDocument({
                organizationId: ctx.me.user.organizationId,
                actorUserId: ctx.me.user.id,
                requestId: request.id,
                documentId: doc.id,
                expectedVersion: doc.version,
                targetFolderId: payload.targetFolderId,
              });
            }
            succeededCount += 1;
            results.push({ documentId, status: "SUCCEEDED" });
            break;
          }

          case "ARCHIVE": {
            if (doc.status !== "ARCHIVED") {
              await archiveDocumentService?.archiveDocument({
                organizationId: ctx.me.user.organizationId,
                actorUserId: ctx.me.user.id,
                requestId: request.id,
                documentId: doc.id,
                expectedVersion: doc.version,
                reason: payload.reason,
              });
            }
            succeededCount += 1;
            results.push({ documentId, status: "SUCCEEDED" });
            break;
          }

          case "TRASH": {
            if (doc.status !== "DELETED") {
              await trashDocumentService?.trashDocument({
                organizationId: ctx.me.user.organizationId,
                actorUserId: ctx.me.user.id,
                requestId: request.id,
                documentId: doc.id,
                expectedVersion: doc.version,
                reason: payload.reason,
              });
            }
            succeededCount += 1;
            results.push({ documentId, status: "SUCCEEDED" });
            break;
          }

          case "ATTACH_TAG": {
            try {
              await tagService?.attachTagToDocument({
                organizationId: ctx.me.user.organizationId,
                actorUserId: ctx.me.user.id,
                requestId: request.id,
                documentId: doc.id,
                tagId: payload.tagId,
              });
            } catch (tagErr) {
              if (tagErr instanceof DomainError && tagErr.code === "TAG_NOT_FOUND") {
                return reply.status(404).send({
                  error: {
                    code: "NOT_FOUND",
                    message: tagErr.message,
                    requestId: request.id,
                  },
                });
              }
              if (
                tagErr instanceof DomainError &&
                tagErr.code === "DOCUMENT_TAG_ALREADY_ATTACHED"
              ) {
                succeededCount += 1;
                results.push({ documentId, status: "SUCCEEDED" });
                continue;
              }
              throw tagErr;
            }
            succeededCount += 1;
            results.push({ documentId, status: "SUCCEEDED" });
            break;
          }
        }
      } catch (error) {
        if (error instanceof DomainError) {
          failedCount += 1;
          results.push({
            documentId,
            status: "FAILED",
            errorCode: error.code,
            message: error.message,
          });
          continue;
        }
        throw error;
      }
    }

    return reply.status(200).send({
      data: {
        action: payload.action,
        totalRequested: uniqueDocIds.length,
        succeededCount,
        failedCount,
        results,
      },
    });
  });

  app.post(`${CONTRACTS_API_PREFIX}/documents/bulk-download`, async (request, reply) => {
    if (
      !documentVersionRepository ||
      !uploadRepository ||
      !storageConnections ||
      !storageRegistry
    ) {
      return reply.status(501).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Serviço de download em lote não configurado.",
          requestId: request.id,
        },
      });
    }

    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const parsed = bulkDocumentDownloadRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            parsed.error.issues[0]?.message ?? "Selecione ao menos um documento para download.",
          requestId: request.id,
        },
      });
    }

    const uniqueDocIds = Array.from(new Set(parsed.data.documentIds));
    const zipEntries: Record<string, Uint8Array> = {};
    const usedNames = new Set<string>();
    const auditedDownloads: Array<{
      readonly documentId: string;
      readonly versionId: string;
      readonly fileObjectId: string;
    }> = [];
    let totalAccumulatedBytes = 0;
    let forbiddenCount = 0;
    let blockedOrUnavailableCount = 0;
    let notFoundCount = 0;

    try {
      for (const documentId of uniqueDocIds) {
        const access = await guard.inspectDocument(
          ctx,
          documentId,
          "DOWNLOAD",
          request.id,
          request.ip,
        );
        if (!access.allowed) {
          if (access.code === "FORBIDDEN") {
            forbiddenCount += 1;
          } else {
            notFoundCount += 1;
          }
          continue;
        }

        const doc = access.document;
        if (doc.status === "DELETED" || !doc.currentVersionId) {
          blockedOrUnavailableCount += 1;
          continue;
        }

        const version = await documentVersionRepository.findById(doc.currentVersionId);
        if (!version || version.documentId !== doc.id) {
          blockedOrUnavailableCount += 1;
          continue;
        }

        if (uploadRepository.findFileObjectOrganizationId) {
          const ownerOrgId = await uploadRepository.findFileObjectOrganizationId(
            version.fileObjectId,
          );
          if (!ownerOrgId || ownerOrgId !== ctx.me.user.organizationId) {
            blockedOrUnavailableCount += 1;
            continue;
          }
        }

        const fileObject = await uploadRepository.findFileObjectById(version.fileObjectId);
        if (!fileObject || !isFileObjectDownloadable(fileObject.status)) {
          blockedOrUnavailableCount += 1;
          continue;
        }

        if (totalAccumulatedBytes + fileObject.sizeBytes > maxBulkZipTotalBytes) {
          return reply.status(413).send({
            error: {
              code: "UPLOAD_TOO_LARGE",
              message:
                "Os arquivos selecionados excedem o limite máximo para compactação em ZIP. Selecione menos itens.",
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
              message: "Conexão de armazenamento indisponível para download em lote.",
              requestId: request.id,
            },
          });
        }

        const provider = await storageRegistry.resolveProvider(connection);
        const downloaded = await provider.getObject({ value: fileObject.objectKey });
        const payloadBuffer = await readStreamToBufferBounded(
          downloaded.body,
          maxBulkZipTotalBytes - totalAccumulatedBytes,
        );
        totalAccumulatedBytes += payloadBuffer.length;

        const entryName = makeUniqueArchiveFileName(fileObject.originalFileName, usedNames);
        zipEntries[entryName] = new Uint8Array(payloadBuffer);
        auditedDownloads.push({
          documentId: doc.id,
          versionId: version.id,
          fileObjectId: fileObject.id,
        });
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === "BULK_ZIP_TOO_LARGE") {
        return reply.status(413).send({
          error: {
            code: "UPLOAD_TOO_LARGE",
            message: error.message,
            requestId: request.id,
          },
        });
      }
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

    if (auditedDownloads.length === 0) {
      if (forbiddenCount > 0 && blockedOrUnavailableCount === 0 && notFoundCount === 0) {
        return reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para baixar os documentos selecionados.",
            requestId: request.id,
          },
        });
      }
      if (blockedOrUnavailableCount > 0) {
        return reply.status(409).send({
          error: {
            code: "FILE_QUARANTINED",
            message:
              "Nenhum dos documentos selecionados possui arquivo liberado pela análise de segurança para download.",
            requestId: request.id,
          },
        });
      }
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Nenhum arquivo disponível foi encontrado para os documentos selecionados.",
          requestId: request.id,
        },
      });
    }

    for (const item of auditedDownloads) {
      await auditWriter.write({
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        action: "DOCUMENT_DOWNLOADED",
        resourceType: "DOCUMENT",
        resourceId: item.documentId,
        result: "SUCCESS",
        requestId: request.id,
        ipAddress: request.ip,
        metadata: {
          versionId: item.versionId,
          fileObjectId: item.fileObjectId,
          delivery: "BULK_ZIP",
        },
      });
    }

    const zipBytes = zipSync(zipEntries, { level: 0 });
    const zipBuffer = Buffer.from(zipBytes);

    reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
    reply.header("Pragma", "no-cache");
    reply.header("Vary", "Cookie, Origin");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", 'attachment; filename="papyrus-documents.zip"');
    reply.header("Content-Length", String(zipBuffer.length));

    return reply.status(200).send(zipBuffer);
  });
}
