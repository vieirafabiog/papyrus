import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CONTRACTS_API_PREFIX,
  type SignedUploadTargetResponseContract,
  type UploadContentResponseContract,
  type UploadSessionRecordContract,
  createSignedUploadTargetRequestSchema,
  createUploadSessionRequestSchema,
  uuidSchema,
} from "@docuflow/contracts";
import {
  type AuditRepositoryPort,
  DomainError,
  type FileObjectEntity,
  type StorageConnectionEntity,
  type StorageConnectionRepositoryPort,
  type TransactionManagerPort,
  type UploadSessionEntity,
  type UploadSessionRepositoryPort,
  type UploadSessionService,
} from "@docuflow/domain";
import {
  StorageError,
  type StorageProviderRegistry,
  hasStorageCapability,
  requireSignedUploadTargetProvider,
  resolveUploadMode,
} from "@docuflow/storage-core";
import { Busboy } from "@fastify/busboy";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type AuthenticatedAuthorizationContext,
  type DocumentAuthorizationGuard,
  buildDocumentQueryScope,
} from "../../plugins/authorization.js";

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_SIGNED_TARGET_TTL_SECONDS = 300;
const MIN_SIGNED_TARGET_TTL_SECONDS = 10;
const MAX_SIGNED_TARGET_TTL_SECONDS = 900;
const PLACEHOLDER_PENDING_CHECKSUM = "0".repeat(64);

class UploadPayloadTooLargeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UploadPayloadTooLargeError";
  }
}

class UploadPayloadValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UploadPayloadValidationError";
  }
}

export interface StorageUploadDependencies {
  readonly connections: StorageConnectionRepositoryPort;
  readonly storageRegistry: StorageProviderRegistry;
  readonly transactions: TransactionManagerPort;
  readonly auditRepository: AuditRepositoryPort;
  readonly maxUploadBytes?: number | undefined;
  readonly tempBaseDirectory?: string | undefined;
  readonly defaultSignedTargetTtlSeconds?: number | undefined;
  readonly maxSignedTargetTtlSeconds?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export type LocalStreamUploadDependencies = StorageUploadDependencies;

interface StreamedTempUploadResult {
  readonly bytesReceived: number;
  readonly checksumSha256: string;
}

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

function createHashAndLimitStream(
  maxBytes: number,
  onBytesUpdate: (total: number) => void,
  hasher: ReturnType<typeof createHash>,
): Transform {
  let bytesSoFar = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesSoFar += chunk.length;
      if (bytesSoFar > maxBytes) {
        callback(
          new UploadPayloadTooLargeError(
            "O conteúdo enviado ultrapassa o tamanho máximo permitido.",
          ),
        );
        return;
      }
      onBytesUpdate(bytesSoFar);
      hasher.update(chunk);
      callback(null, chunk);
    },
  });
}

async function streamRawBodyToTempFile(
  bodyStream: Readable,
  tempFilePath: string,
  maxBytes: number,
): Promise<StreamedTempUploadResult> {
  const hasher = createHash("sha256");
  let bytesReceived = 0;
  const inspector = createHashAndLimitStream(
    maxBytes,
    (total) => {
      bytesReceived = total;
    },
    hasher,
  );
  const writer = createWriteStream(tempFilePath, { flags: "wx", mode: 0o600 });
  await pipeline(bodyStream, inspector, writer);

  return {
    bytesReceived,
    checksumSha256: hasher.digest("hex"),
  };
}

async function streamMultipartFileToTempFile(
  bodyStream: Readable,
  contentTypeHeader: string,
  tempFilePath: string,
  maxBytes: number,
): Promise<StreamedTempUploadResult> {
  const busboy = new Busboy({
    headers: { "content-type": contentTypeHeader },
    limits: {
      files: 1,
      fileSize: maxBytes,
    },
  });

  const hasher = createHash("sha256");
  let bytesReceived = 0;
  let fileCount = 0;
  let filePipelinePromise: Promise<void> | null = null;
  let limitTriggered = false;
  let parserError: Error | null = null;

  const donePromise = new Promise<void>((resolve, reject) => {
    const fail = (err: Error): void => {
      if (!parserError) {
        parserError = err;
        bodyStream.unpipe(busboy);
        busboy.destroy(err);
        reject(err);
      }
    };

    busboy.on("filesLimit", () => {
      fail(new UploadPayloadValidationError("Envie apenas um arquivo por sessão de upload."));
    });

    busboy.on("file", (_fieldName, fileStream) => {
      fileCount += 1;
      if (fileCount > 1) {
        fileStream.resume();
        fail(new UploadPayloadValidationError("Envie apenas um arquivo por sessão de upload."));
        return;
      }

      fileStream.on("limit", () => {
        limitTriggered = true;
      });

      const inspector = createHashAndLimitStream(
        maxBytes,
        (total) => {
          bytesReceived = total;
        },
        hasher,
      );
      const writer = createWriteStream(tempFilePath, { flags: "wx", mode: 0o600 });

      filePipelinePromise = pipeline(fileStream, inspector, writer).catch((err: unknown) => {
        const mapped =
          err instanceof Error ? err : new UploadPayloadValidationError("Falha ao ler arquivo.");
        fail(mapped);
        throw mapped;
      });
    });

    busboy.on("error", (err: unknown) => {
      fail(
        err instanceof Error
          ? err
          : new UploadPayloadValidationError("Requisição multipart malformada."),
      );
    });

    busboy.on("finish", () => {
      if (parserError) {
        return;
      }
      if (!filePipelinePromise) {
        reject(
          new UploadPayloadValidationError(
            "Nenhum arquivo binário encontrado no formulário multipart.",
          ),
        );
        return;
      }
      void filePipelinePromise
        .then(() => {
          if (limitTriggered) {
            reject(
              new UploadPayloadTooLargeError(
                "O arquivo multipart excede o limite de tamanho permitido.",
              ),
            );
            return;
          }
          resolve();
        })
        .catch(reject);
    });
  });

  bodyStream.on("error", (err) => {
    busboy.destroy(err);
  });
  bodyStream.pipe(busboy);

  await donePromise;

  return {
    bytesReceived,
    checksumSha256: hasher.digest("hex"),
  };
}

export async function registerUploadRoutes(
  app: FastifyInstance,
  deps: {
    readonly guard: DocumentAuthorizationGuard;
    readonly uploadSessionService: UploadSessionService;
    readonly uploadRepository: UploadSessionRepositoryPort;
    readonly storageUploadDeps?: StorageUploadDependencies | undefined;
    readonly localUploadDeps?: LocalStreamUploadDependencies | undefined;
  },
): Promise<void> {
  const { guard, uploadSessionService, uploadRepository } = deps;
  const uploadStorageDeps = deps.storageUploadDeps ?? deps.localUploadDeps;
  const maxUploadBytes = uploadStorageDeps?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const nowFn = uploadStorageDeps?.now ?? (() => new Date());
  const defaultSignedTargetTtlSeconds =
    uploadStorageDeps?.defaultSignedTargetTtlSeconds ?? DEFAULT_SIGNED_TARGET_TTL_SECONDS;
  const maxSignedTargetTtlSeconds =
    uploadStorageDeps?.maxSignedTargetTtlSeconds ?? MAX_SIGNED_TARGET_TTL_SECONDS;

  // Pass raw stream directly for multipart and binary uploads inside this encapsulated plugin
  // without buffering the whole payload into memory.
  app.addContentTypeParser(/^multipart\/form-data(?:\s*;.*)?$/i, (_request, payload, done) => {
    done(null, payload);
  });
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });
  app.addContentTypeParser("application/pdf", (_request, payload, done) => {
    done(null, payload);
  });
  app.addContentTypeParser(/^image\/[a-z0-9.+-]+$/i, (_request, payload, done) => {
    done(null, payload);
  });

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

  if (uploadStorageDeps) {
    interface AuthorizedPendingUpload {
      readonly ctx: AuthenticatedAuthorizationContext;
      readonly session: UploadSessionEntity;
      readonly fileObject: FileObjectEntity;
      readonly connection: StorageConnectionEntity;
    }

    const loadAuthorizedPendingUpload = async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ): Promise<AuthorizedPendingUpload | null> => {
      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return null;
      }

      const idParsed = uuidSchema.safeParse(request.params.id);
      if (!idParsed.success) {
        void reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificador de sessão de upload inválido.",
            requestId: request.id,
          },
        });
        return null;
      }

      const session = await uploadRepository.findById(idParsed.data);
      const uploadScope = buildDocumentQueryScope(ctx.loaded, ctx.rolePermissions, "UPLOAD");
      const hasAnyUploadGrant =
        !uploadScope.hasGlobalDeny &&
        (uploadScope.hasGlobalAllow ||
          uploadScope.allowedCategoryIds.length > 0 ||
          uploadScope.allowedFolderIds.length > 0 ||
          uploadScope.allowedDocumentIds.length > 0);

      if (
        !session ||
        session.organizationId !== ctx.me.user.organizationId ||
        session.userId !== ctx.me.user.id ||
        !hasAnyUploadGrant
      ) {
        void reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para operar esta sessão de upload.",
            requestId: request.id,
          },
        });
        return null;
      }

      if (new Date(session.expiresAt).getTime() <= nowFn().getTime()) {
        await uploadRepository.markSessionExpired(session.id);
        void reply.status(409).send({
          error: {
            code: "CONFLICT",
            message: "A sessão de upload expirou.",
            requestId: request.id,
          },
        });
        return null;
      }

      if (session.status !== "PENDING") {
        void reply.status(409).send({
          error: {
            code: "CONFLICT",
            message: "A sessão de upload não está mais pendente para envio.",
            requestId: request.id,
          },
        });
        return null;
      }

      const fileObject = await uploadRepository.findFileObjectById(session.fileObjectId);
      if (!fileObject) {
        void reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Objeto temporário da sessão não encontrado.",
            requestId: request.id,
          },
        });
        return null;
      }

      if (fileObject.status !== "UPLOADING") {
        void reply.status(409).send({
          error: {
            code: "CONFLICT",
            message: "O objeto associado a esta sessão não aceita mais envio.",
            requestId: request.id,
          },
        });
        return null;
      }

      const connection = await uploadStorageDeps.connections.findById(session.storageConnectionId);
      if (
        !connection ||
        connection.organizationId !== ctx.me.user.organizationId ||
        connection.status !== "ACTIVE"
      ) {
        void reply.status(503).send({
          error: {
            code: "STORAGE_UNAVAILABLE",
            message: "Conexão de armazenamento de destino indisponível.",
            requestId: request.id,
          },
        });
        return null;
      }

      return { ctx, session, fileObject, connection };
    };

    const handleStreamContentUpload = async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const authorized = await loadAuthorizedPendingUpload(request, reply);
      if (!authorized) {
        return reply;
      }
      const { ctx, session, fileObject, connection } = authorized;

      if (connection.kind !== "local") {
        return reply.status(409).send({
          error: {
            code: "CONFLICT",
            message: "Esta sessão exige envio direto para o provedor configurado.",
            requestId: request.id,
          },
        });
      }

      if (!(request.body instanceof Readable)) {
        return reply.status(415).send({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "Tipo de conteúdo não suportado para streaming de upload.",
            requestId: request.id,
          },
        });
      }

      const effectiveLimit = Math.min(maxUploadBytes, session.declaredSizeBytes);
      const contentTypeHeader = request.headers["content-type"] ?? "";
      const isMultipart = /^multipart\/form-data/i.test(contentTypeHeader);

      let tempDir: string | null = null;
      const cleanupTempDir = async (): Promise<void> => {
        if (tempDir) {
          const target = tempDir;
          tempDir = null;
          await rm(target, { recursive: true, force: true });
        }
      };

      let outcomeStatus = 200;
      let outcomeBody: unknown;

      try {
        try {
          const provider = await uploadStorageDeps.storageRegistry.resolveProvider(connection);
          resolveUploadMode(provider, false);

          tempDir = await mkdtemp(
            path.join(uploadStorageDeps.tempBaseDirectory ?? os.tmpdir(), "docuflow-api-upload-"),
          );
          const tempFilePath = path.join(tempDir, `${session.id}.bin`);

          const streamed = isMultipart
            ? await streamMultipartFileToTempFile(
                request.body,
                contentTypeHeader,
                tempFilePath,
                effectiveLimit,
              )
            : await streamRawBodyToTempFile(request.body, tempFilePath, effectiveLimit);

          if (streamed.bytesReceived <= 0) {
            outcomeStatus = 400;
            outcomeBody = {
              error: {
                code: "VALIDATION_ERROR",
                message: "Arquivo vazio não é permitido nesta sessão de upload.",
                requestId: request.id,
              },
            };
          } else if (streamed.bytesReceived !== session.declaredSizeBytes) {
            outcomeStatus = 400;
            outcomeBody = {
              error: {
                code: "VALIDATION_ERROR",
                message: "O tamanho recebido diverge do tamanho declarado na sessão.",
                requestId: request.id,
              },
            };
          } else if (
            fileObject.checksumSha256 !== PLACEHOLDER_PENDING_CHECKSUM &&
            fileObject.checksumSha256.toLowerCase() !== streamed.checksumSha256
          ) {
            outcomeStatus = 400;
            outcomeBody = {
              error: {
                code: "VALIDATION_ERROR",
                message: "O checksum SHA-256 recebido diverge do checksum declarado na sessão.",
                requestId: request.id,
              },
            };
          } else {
            const providerInputStream = createReadStream(tempFilePath);
            await provider.putObject({
              key: { value: fileObject.objectKey },
              body: providerInputStream,
              metadata: {
                contentType: session.declaredContentType,
                contentLength: streamed.bytesReceived,
                checksumSha256: streamed.checksumSha256,
              },
            });

            const updatedRecords = await uploadStorageDeps.transactions.runInTransaction(
              async (tx) => {
                const marked = await uploadRepository.markUploadReceived(
                  {
                    sessionId: session.id,
                    fileObjectId: fileObject.id,
                    sizeBytes: streamed.bytesReceived,
                    checksumSha256: streamed.checksumSha256,
                  },
                  tx,
                );
                if (!marked) {
                  return null;
                }

                await uploadStorageDeps.auditRepository.append(
                  {
                    organizationId: ctx.me.user.organizationId,
                    actorUserId: ctx.me.user.id,
                    action: "UPLOAD_BINARY_RECEIVED",
                    resourceType: "UPLOAD_SESSION",
                    resourceId: session.id,
                    result: "SUCCESS",
                    requestId: request.id,
                    metadata: {
                      storageConnectionId: session.storageConnectionId,
                      bytesReceived: streamed.bytesReceived,
                      progressPercent: 100,
                    },
                  },
                  tx,
                );

                return marked;
              },
            );

            if (!updatedRecords) {
              outcomeStatus = 409;
              outcomeBody = {
                error: {
                  code: "CONFLICT",
                  message: "A sessão de upload já recebeu o binário ou não está mais pendente.",
                  requestId: request.id,
                },
              };
            } else {
              const responseData: UploadContentResponseContract = {
                sessionId: updatedRecords.session.id,
                fileObjectId: updatedRecords.fileObject.id,
                storageConnectionId: updatedRecords.session.storageConnectionId,
                status: updatedRecords.session.status,
                fileObjectStatus: updatedRecords.fileObject.status,
                bytesReceived: streamed.bytesReceived,
                expectedBytes: updatedRecords.session.declaredSizeBytes,
                progressPercent: 100,
                checksumSha256: streamed.checksumSha256,
              };
              outcomeStatus = 200;
              outcomeBody = { data: responseData };
            }
          }
        } finally {
          await cleanupTempDir();
        }

        return reply.status(outcomeStatus).send(outcomeBody);
      } catch (error) {
        await cleanupTempDir();
        if (error instanceof UploadPayloadTooLargeError) {
          return reply.status(413).send({
            error: {
              code: "UPLOAD_TOO_LARGE",
              message: error.message,
              requestId: request.id,
            },
          });
        }
        if (error instanceof UploadPayloadValidationError) {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: error.message,
              requestId: request.id,
            },
          });
        }
        if (error instanceof StorageError) {
          const status = error.code === "UNAVAILABLE" ? 503 : 400;
          return reply.status(status).send({
            error: {
              code: error.code === "UNAVAILABLE" ? "STORAGE_UNAVAILABLE" : "VALIDATION_ERROR",
              message: error.message,
              requestId: request.id,
            },
          });
        }
        throw error;
      }
    };

    const handleIssueSignedUploadTarget = async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const authorized = await loadAuthorizedPendingUpload(request, reply);
      if (!authorized) {
        return reply;
      }
      const { ctx, session, fileObject, connection } = authorized;

      const parsedBody = createSignedUploadTargetRequestSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Parâmetros inválidos para emissão de destino temporário de upload.",
            requestId: request.id,
          },
        });
      }

      if (session.declaredSizeBytes > maxUploadBytes) {
        return reply.status(413).send({
          error: {
            code: "UPLOAD_TOO_LARGE",
            message: "O tamanho declarado da sessão excede o limite atual de upload.",
            requestId: request.id,
          },
        });
      }

      const remainingSessionSeconds = Math.floor(
        (new Date(session.expiresAt).getTime() - nowFn().getTime()) / 1000,
      );
      if (remainingSessionSeconds < MIN_SIGNED_TARGET_TTL_SECONDS) {
        return reply.status(409).send({
          error: {
            code: "CONFLICT",
            message:
              "Tempo restante da sessão de upload insuficiente para emitir destino temporário seguro.",
            requestId: request.id,
          },
        });
      }

      const requestedTtl = parsedBody.data.expiresInSeconds ?? defaultSignedTargetTtlSeconds;
      const effectiveTtl = Math.min(
        requestedTtl,
        maxSignedTargetTtlSeconds,
        remainingSessionSeconds,
      );

      try {
        const provider = await uploadStorageDeps.storageRegistry.resolveProvider(connection);
        if (
          !hasStorageCapability(provider, "signedUpload") ||
          resolveUploadMode(provider, true) !== "SIGNED_UPLOAD"
        ) {
          return reply.status(409).send({
            error: {
              code: "CONFLICT",
              message:
                "Esta conexão de armazenamento não suporta upload direto assinado; utilize streaming pela API.",
              requestId: request.id,
            },
          });
        }

        const signedProvider = requireSignedUploadTargetProvider(provider);
        const signedTarget = await signedProvider.createSignedUploadTarget({
          key: { value: fileObject.objectKey },
          contentType: session.declaredContentType,
          contentLength: session.declaredSizeBytes,
          expiresInSeconds: effectiveTtl,
        });
        if (signedTarget.method !== "PUT") {
          throw new StorageError(
            "CAPABILITY_NOT_SUPPORTED",
            "Método HTTP inválido retornado para destino temporário de upload.",
            connection.kind,
          );
        }

        await uploadStorageDeps.auditRepository.append({
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          action: "UPLOAD_SIGNED_TARGET_ISSUED",
          resourceType: "UPLOAD_SESSION",
          resourceId: session.id,
          result: "SUCCESS",
          requestId: request.id,
          metadata: {
            storageConnectionId: connection.id,
            declaredSizeBytes: session.declaredSizeBytes,
            ttlSeconds: effectiveTtl,
            targetExpiresAt: signedTarget.expiresAt.toISOString(),
          },
        });

        const responseData: SignedUploadTargetResponseContract = {
          sessionId: session.id,
          fileObjectId: fileObject.id,
          storageConnectionId: session.storageConnectionId,
          uploadMode: "SIGNED_UPLOAD",
          finalizationRequired: true,
          status: session.status,
          fileObjectStatus: fileObject.status,
          target: {
            url: signedTarget.url,
            method: signedTarget.method,
            headers: signedTarget.headers,
            expiresAt: signedTarget.expiresAt.toISOString(),
          },
        };

        return reply
          .header("Cache-Control", "private, no-store")
          .header("Pragma", "no-cache")
          .status(200)
          .send({ data: responseData });
      } catch (error) {
        if (error instanceof StorageError) {
          const status =
            error.code === "UNAVAILABLE" || error.code === "TIMEOUT"
              ? 503
              : error.code === "CONFLICT" || error.code === "CAPABILITY_NOT_SUPPORTED"
                ? 409
                : 400;
          const code =
            status === 503
              ? "STORAGE_UNAVAILABLE"
              : status === 409
                ? "CONFLICT"
                : "VALIDATION_ERROR";
          return reply.status(status).send({
            error: {
              code,
              message: error.message,
              requestId: request.id,
            },
          });
        }
        throw error;
      }
    };

    const streamBodyLimit = Math.max(maxUploadBytes * 2, 100 * 1024 * 1024);

    app.post<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/uploads/sessions/:id/signed-target`,
      handleIssueSignedUploadTarget,
    );
    app.post<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/uploads/sessions/:id/content`,
      { bodyLimit: streamBodyLimit },
      handleStreamContentUpload,
    );
    app.put<{ Params: { id: string } }>(
      `${CONTRACTS_API_PREFIX}/uploads/sessions/:id/content`,
      { bodyLimit: streamBodyLimit },
      handleStreamContentUpload,
    );
  }
}
