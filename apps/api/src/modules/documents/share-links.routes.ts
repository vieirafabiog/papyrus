import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import { createPasswordService } from "@papyrus/auth";
import {
  CONTRACTS_API_PREFIX,
  type ErrorCode,
  createDocumentShareLinkRequestSchema,
  unlockPublicShareRequestSchema,
  uuidSchema,
} from "@papyrus/contracts";
import {
  type DocumentShareLinkEntity,
  type DocumentShareService,
  DomainError,
  type ShareLinkCryptoPort,
  type StorageConnectionRepositoryPort,
  computeShareLinkStatus,
} from "@papyrus/domain";
import {
  StorageError,
  type StorageProviderRegistry,
  assertStorageCapability,
} from "@papyrus/storage-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DocumentAuthorizationGuard } from "../../plugins/authorization.js";
import { createLoginRateLimiter } from "../../plugins/security.js";
import { sanitizeDownloadFileName } from "./download.routes.js";
import {
  OfficePreviewConversionError,
  type OfficePreviewConverterPort,
} from "./office-preview-converter.js";
import {
  ALLOWED_PREVIEW_IMAGE_MIME_TYPES,
  ALLOWED_PREVIEW_SPREADSHEET_MIME_TYPES,
  ALLOWED_PREVIEW_TEXT_MIME_TYPES,
  DEFAULT_MAX_IMAGE_PREVIEW_BYTES,
  DEFAULT_MAX_OFFICE_PREVIEW_BYTES,
  DEFAULT_MAX_SPREADSHEET_PREVIEW_BYTES,
  DEFAULT_MAX_TEXT_PREVIEW_BYTES,
  isOfficePdfPreviewable,
} from "./preview.routes.js";

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;
const ALL_ZERO_SHA256 = "0".repeat(64);
const SHARE_UNLOCK_HEADER_NAME = "x-share-unlock";

export const SHARE_PUBLIC_PASSCODE_MAX_ATTEMPTS = 5;
export const SHARE_PUBLIC_PASSCODE_WINDOW_MS = 60_000;

export interface DocumentShareRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly shareService: DocumentShareService;
  readonly shareCrypto: ShareLinkCryptoPort;
  readonly storageConnections: StorageConnectionRepositoryPort;
  readonly storageRegistry: StorageProviderRegistry;
  readonly officePreviewConverter?: OfficePreviewConverterPort | undefined;
  readonly maxImagePreviewBytes?: number | undefined;
  readonly maxTextPreviewBytes?: number | undefined;
  readonly maxSpreadsheetPreviewBytes?: number | undefined;
  readonly maxOfficePreviewBytes?: number | undefined;
}

/**
 * Builds the cryptographic adapter used by temporary document share links:
 * 256-bit random URL tokens, HMAC-SHA-256 token hashing, Argon2id passcodes,
 * and short-lived HMAC-signed unlock proofs scoped to a single link hash.
 */
export function createShareLinkCryptoAdapter(masterSecret: string): ShareLinkCryptoPort {
  if (masterSecret.trim().length < 16) {
    throw new Error("Share link cryptographic secret must contain at least 16 characters.");
  }

  const passcodeService = createPasswordService({
    minPasswordLength: 6,
    maxPasswordLength: 128,
  });

  const signProofPayload = (tokenHash: string, payload: string): string =>
    createHmac("sha256", `${masterSecret}:share-unlock`)
      .update(`${tokenHash}:${payload}`)
      .digest("base64url");

  return {
    generateRawToken(): string {
      return randomBytes(32).toString("base64url");
    },

    hashToken(rawToken: string): string {
      return createHmac("sha256", `${masterSecret}:share-token`).update(rawToken).digest("hex");
    },

    hashPasscode(plainPasscode: string): Promise<string> {
      return passcodeService.hashPassword(plainPasscode);
    },

    verifyPasscode(plainPasscode: string, storedHash: string): Promise<boolean> {
      return passcodeService.verifyPassword(plainPasscode, storedHash);
    },

    issueUnlockProof(tokenHash: string, expiresAtEpochSeconds: number): string {
      const nonce = randomBytes(16).toString("base64url");
      const payload = `${expiresAtEpochSeconds}.${nonce}`;
      const signature = signProofPayload(tokenHash, payload);
      return `${payload}.${signature}`;
    },

    verifyUnlockProof(tokenHash: string, unlockToken: string, nowEpochSeconds: number): boolean {
      const parts = unlockToken.split(".");
      if (parts.length !== 3) {
        return false;
      }
      const [expRaw, nonce, providedSig] = parts;
      if (!expRaw || !nonce || !providedSig) {
        return false;
      }
      const expiresAt = Number(expRaw);
      if (!Number.isInteger(expiresAt) || expiresAt <= nowEpochSeconds) {
        return false;
      }

      const expectedSig = signProofPayload(tokenHash, `${expRaw}.${nonce}`);
      const bufA = Buffer.from(providedSig, "utf8");
      const bufB = Buffer.from(expectedSig, "utf8");
      if (bufA.length !== bufB.length) {
        return false;
      }
      return timingSafeEqual(bufA, bufB);
    },
  };
}

function serializeShareLink(link: DocumentShareLinkEntity, now: Date) {
  return {
    id: link.id,
    documentId: link.documentId,
    documentVersionId: link.documentVersionId,
    label: link.label,
    allowDownload: link.allowDownload,
    requiresPasscode: link.passcodeHash !== null,
    maxUses: link.maxUses,
    useCount: link.useCount,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    lastAccessedAt: link.lastAccessedAt,
    status: computeShareLinkStatus(link, now),
    createdBy: link.createdBy,
    createdAt: link.createdAt,
  };
}

function applyPublicNoIndexHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Origin, X-Share-Unlock");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
}

function mapShareDomainError(code: string): { status: number; apiCode: ErrorCode } {
  switch (code) {
    case "DOCUMENT_NOT_FOUND":
    case "VERSION_NOT_FOUND":
    case "SHARE_LINK_NOT_FOUND":
    case "SHARE_LINK_UNAVAILABLE":
      return { status: 404, apiCode: "NOT_FOUND" };
    case "FILE_QUARANTINED":
    case "FILE_NOT_AVAILABLE_FOR_SHARE":
      return { status: 409, apiCode: "FILE_QUARANTINED" };
    case "DOCUMENT_DELETED_SHARE_FORBIDDEN":
    case "DOCUMENT_VERSION_REQUIRED":
      return { status: 409, apiCode: "CONFLICT" };
    case "SHARE_PASSCODE_REQUIRED":
    case "SHARE_PASSCODE_INVALID":
      return { status: 401, apiCode: "UNAUTHORIZED" };
    case "SHARE_DOWNLOAD_FORBIDDEN":
      return { status: 403, apiCode: "FORBIDDEN" };
    default:
      return { status: 400, apiCode: "VALIDATION_ERROR" };
  }
}

function handleShareError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof DomainError) {
    const mapped = mapShareDomainError(error.code);
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

async function readStreamToBufferBounded(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new DomainError(
        "PREVIEW_TOO_LARGE",
        "O arquivo excede o tamanho máximo permitido para pré-visualização.",
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

function resolvePreviewMaxBytes(
  mimeType: string,
  originalFileName: string,
  limits: {
    readonly maxImagePreviewBytes: number;
    readonly maxTextPreviewBytes: number;
    readonly maxSpreadsheetPreviewBytes: number;
    readonly maxOfficePreviewBytes: number;
  },
): number | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "application/pdf") {
    return null;
  }
  if (ALLOWED_PREVIEW_IMAGE_MIME_TYPES.has(normalized)) {
    return limits.maxImagePreviewBytes;
  }
  if (ALLOWED_PREVIEW_TEXT_MIME_TYPES.has(normalized)) {
    return limits.maxTextPreviewBytes;
  }
  if (ALLOWED_PREVIEW_SPREADSHEET_MIME_TYPES.has(normalized)) {
    return limits.maxSpreadsheetPreviewBytes;
  }
  if (isOfficePdfPreviewable(normalized, originalFileName)) {
    return limits.maxOfficePreviewBytes;
  }
  return null;
}

function isSupportedSharePreviewFormat(mimeType: string, originalFileName: string): boolean {
  const normalized = mimeType.toLowerCase();
  return (
    normalized === "application/pdf" ||
    ALLOWED_PREVIEW_IMAGE_MIME_TYPES.has(normalized) ||
    ALLOWED_PREVIEW_TEXT_MIME_TYPES.has(normalized) ||
    ALLOWED_PREVIEW_SPREADSHEET_MIME_TYPES.has(normalized) ||
    isOfficePdfPreviewable(normalized, originalFileName)
  );
}

/**
 * Registers authenticated temporary share link management endpoints and hardened
 * anonymous public endpoints (`/api/v1/share/:token`) with rate limiting and strict CSP.
 */
export async function registerDocumentShareRoutes(
  app: FastifyInstance,
  deps: DocumentShareRoutesDependencies,
): Promise<void> {
  const {
    guard,
    shareService,
    shareCrypto,
    storageConnections,
    storageRegistry,
    officePreviewConverter,
  } = deps;

  const maxImagePreviewBytes = deps.maxImagePreviewBytes ?? DEFAULT_MAX_IMAGE_PREVIEW_BYTES;
  const maxTextPreviewBytes = deps.maxTextPreviewBytes ?? DEFAULT_MAX_TEXT_PREVIEW_BYTES;
  const maxSpreadsheetPreviewBytes =
    deps.maxSpreadsheetPreviewBytes ?? DEFAULT_MAX_SPREADSHEET_PREVIEW_BYTES;
  const maxOfficePreviewBytes = deps.maxOfficePreviewBytes ?? DEFAULT_MAX_OFFICE_PREVIEW_BYTES;

  const unlockLimiter = createLoginRateLimiter({
    maxAttempts: SHARE_PUBLIC_PASSCODE_MAX_ATTEMPTS,
    windowMs: SHARE_PUBLIC_PASSCODE_WINDOW_MS,
  });

  app.get(`${CONTRACTS_API_PREFIX}/documents/:id/share-links`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const params = request.params as { id?: string };
    const idParsed = uuidSchema.safeParse(params.id);
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
      "DOWNLOAD",
      reply,
      request.id,
      request.ip,
    );
    if (!doc) {
      return reply;
    }

    const list = await shareService.listShareLinks({
      organizationId: ctx.me.user.organizationId,
      documentId: doc.id,
    });

    const now = new Date();
    reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
    reply.header("Pragma", "no-cache");
    reply.header("Vary", "Cookie, Origin");

    return reply.status(200).send({
      data: {
        items: list.map((link) => serializeShareLink(link, now)),
      },
    });
  });

  app.post(`${CONTRACTS_API_PREFIX}/documents/:id/share-links`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const params = request.params as { id?: string };
    const idParsed = uuidSchema.safeParse(params.id);
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
      "DOWNLOAD",
      reply,
      request.id,
      request.ip,
    );
    if (!doc) {
      return reply;
    }

    const bodyParsed = createDocumentShareLinkRequestSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            bodyParsed.error.issues[0]?.message ?? "Configuração inválida para link temporário.",
          requestId: request.id,
        },
      });
    }

    try {
      const created = await shareService.createShareLink({
        organizationId: ctx.me.user.organizationId,
        documentId: doc.id,
        versionId: bodyParsed.data.versionId,
        actorUserId: ctx.me.user.id,
        requestId: request.id,
        ipAddress: request.ip,
        expiresInMinutes: bodyParsed.data.expiresInMinutes,
        maxUses: bodyParsed.data.maxUses,
        allowDownload: bodyParsed.data.allowDownload,
        passcode: bodyParsed.data.passcode,
        label: bodyParsed.data.label,
      });

      reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
      reply.header("Pragma", "no-cache");

      return reply.status(201).send({
        data: {
          link: serializeShareLink(created.link, new Date()),
          shareToken: created.shareToken,
        },
      });
    } catch (error) {
      return handleShareError(error, request, reply);
    }
  });

  app.delete(
    `${CONTRACTS_API_PREFIX}/documents/:id/share-links/:shareLinkId`,
    async (request, reply) => {
      const ctx = await guard.requireSubject(request, reply);
      if (!ctx) {
        return reply;
      }

      const params = request.params as { id?: string; shareLinkId?: string };
      const docIdParsed = uuidSchema.safeParse(params.id);
      const linkIdParsed = uuidSchema.safeParse(params.shareLinkId);
      if (!docIdParsed.success || !linkIdParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Identificadores inválidos para revogação do link.",
            requestId: request.id,
          },
        });
      }

      const doc = await guard.authorizeDocument(
        ctx,
        docIdParsed.data,
        "DOWNLOAD",
        reply,
        request.id,
        request.ip,
      );
      if (!doc) {
        return reply;
      }

      try {
        const revoked = await shareService.revokeShareLink({
          organizationId: ctx.me.user.organizationId,
          documentId: doc.id,
          shareLinkId: linkIdParsed.data,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          ipAddress: request.ip,
        });

        return reply.status(200).send({
          data: {
            revoked: true as const,
            shareLinkId: revoked.id,
          },
        });
      } catch (error) {
        return handleShareError(error, request, reply);
      }
    },
  );

  app.get<{ Params: { token: string } }>(
    `${CONTRACTS_API_PREFIX}/share/:token`,
    async (request, reply) => {
      applyPublicNoIndexHeaders(reply);
      const rawUnlock = request.headers[SHARE_UNLOCK_HEADER_NAME];
      const unlockToken = typeof rawUnlock === "string" ? rawUnlock : undefined;

      try {
        const metadata = await shareService.getPublicMetadata({
          rawToken: request.params.token,
          unlockToken,
        });

        return reply.status(200).send({
          data: {
            title: metadata.title,
            originalFileName: metadata.originalFileName,
            detectedContentType: metadata.detectedContentType,
            sizeBytes: metadata.sizeBytes,
            allowDownload: metadata.allowDownload,
            requiresPasscode: metadata.requiresPasscode,
            unlocked: metadata.unlocked,
            expiresAt: metadata.expiresAt,
            maxUses: metadata.maxUses,
            remainingUses: metadata.remainingUses,
          },
        });
      } catch (error) {
        return handleShareError(error, request, reply);
      }
    },
  );

  app.post<{ Params: { token: string } }>(
    `${CONTRACTS_API_PREFIX}/share/:token/unlock`,
    async (request, reply) => {
      applyPublicNoIndexHeaders(reply);

      const tokenHash = shareCrypto.hashToken(request.params.token.trim());
      const limitKey = `${request.ip || "unknown"}:${tokenHash}`;
      const limitOutcome = unlockLimiter.consume(limitKey);
      if (!limitOutcome.allowed) {
        await shareService.recordAccessDenied({
          rawToken: request.params.token,
          reason: "PASSCODE_RATE_LIMITED",
          requestId: request.id,
          ipAddress: request.ip,
        });
        reply.header("Retry-After", String(limitOutcome.retryAfterSeconds));
        return reply.status(429).send({
          error: {
            code: "RATE_LIMITED",
            message: "Muitas tentativas de senha incorreta. Aguarde antes de tentar novamente.",
            requestId: request.id,
          },
        });
      }

      const bodyParsed = unlockPublicShareRequestSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: bodyParsed.error.issues[0]?.message ?? "Informe a senha de proteção do link.",
            requestId: request.id,
          },
        });
      }

      try {
        const result = await shareService.unlockPublicShare({
          rawToken: request.params.token,
          passcode: bodyParsed.data.passcode,
          requestId: request.id,
          ipAddress: request.ip,
        });
        unlockLimiter.reset(limitKey);
        return reply.status(200).send({ data: result });
      } catch (error) {
        return handleShareError(error, request, reply);
      }
    },
  );

  app.get<{ Params: { token: string } }>(
    `${CONTRACTS_API_PREFIX}/share/:token/content`,
    async (request, reply) => {
      applyPublicNoIndexHeaders(reply);
      const rawUnlock = request.headers[SHARE_UNLOCK_HEADER_NAME];
      const unlockToken = typeof rawUnlock === "string" ? rawUnlock : undefined;

      try {
        const meta = await shareService.getPublicMetadata({
          rawToken: request.params.token,
          unlockToken,
        });

        const detectedMime = meta.detectedContentType.toLowerCase();
        if (!isSupportedSharePreviewFormat(detectedMime, meta.originalFileName)) {
          return reply.status(415).send({
            error: {
              code: "UNSUPPORTED_MEDIA_TYPE",
              message: "Este formato de arquivo requer download para visualização.",
              requestId: request.id,
            },
          });
        }

        const officePdf = isOfficePdfPreviewable(detectedMime, meta.originalFileName);
        if (officePdf && !officePreviewConverter) {
          return reply.status(503).send({
            error: {
              code: "PREVIEW_CONVERTER_UNAVAILABLE",
              message: "O conversor de pré-visualização Office não está disponível neste ambiente.",
              requestId: request.id,
            },
          });
        }

        const maxBytes = resolvePreviewMaxBytes(detectedMime, meta.originalFileName, {
          maxImagePreviewBytes,
          maxTextPreviewBytes,
          maxSpreadsheetPreviewBytes,
          maxOfficePreviewBytes,
        });
        if (maxBytes !== null && meta.sizeBytes > maxBytes) {
          return reply.status(413).send({
            error: {
              code: "UPLOAD_TOO_LARGE",
              message: "O arquivo excede o tamanho máximo suportado para pré-visualização.",
              requestId: request.id,
            },
          });
        }

        const deliveryTarget = await shareService.consumeForDelivery({
          rawToken: request.params.token,
          delivery: "PREVIEW",
          unlockToken,
          requestId: request.id,
          ipAddress: request.ip,
        });

        const { fileObject, organizationId } = deliveryTarget;
        const connection = await storageConnections.findById(fileObject.storageConnectionId);
        if (
          !connection ||
          connection.organizationId !== organizationId ||
          connection.status !== "ACTIVE"
        ) {
          return reply.status(503).send({
            error: {
              code: "STORAGE_UNAVAILABLE",
              message: "Conexão de armazenamento indisponível para leitura.",
              requestId: request.id,
            },
          });
        }

        const provider = await storageRegistry.resolveProvider(connection);
        assertStorageCapability(provider, "streamingRead");
        const downloaded = await provider.getObject({ value: fileObject.objectKey });

        const returnedChecksum = downloaded.metadata.checksumSha256.trim().toLowerCase();
        if (
          SHA256_HEX_REGEX.test(returnedChecksum) &&
          returnedChecksum !== ALL_ZERO_SHA256 &&
          returnedChecksum !== fileObject.checksumSha256.toLowerCase()
        ) {
          downloaded.body.destroy();
          return reply.status(409).send({
            error: {
              code: "CONFLICT",
              message: "Falha de integridade ao ler o arquivo compartilhado.",
              requestId: request.id,
            },
          });
        }

        if (officePdf && officePreviewConverter) {
          const sourceBuffer = await readStreamToBufferBounded(
            downloaded.body,
            maxOfficePreviewBytes,
          );
          const pdfBuffer = await officePreviewConverter.convertToPdf({
            buffer: sourceBuffer,
            originalFileName: fileObject.originalFileName,
            mimeType: detectedMime,
            checksumSha256: fileObject.checksumSha256,
          });
          const safePdfName = `${sanitizeDownloadFileName(fileObject.originalFileName)}.pdf`;
          reply.header("Content-Type", "application/pdf");
          reply.header("Content-Disposition", `inline; filename="${safePdfName}"`);
          reply.header("Content-Length", String(pdfBuffer.length));
          reply.header(
            "Content-Security-Policy",
            "default-src 'none'; img-src 'self'; object-src 'self'; frame-ancestors 'self'",
          );
          reply.header("X-Frame-Options", "SAMEORIGIN");
          return reply.status(200).send(pdfBuffer);
        }

        const safeInlineName = sanitizeDownloadFileName(fileObject.originalFileName);
        const isTextLike = ALLOWED_PREVIEW_TEXT_MIME_TYPES.has(detectedMime);
        const isSpreadsheet = ALLOWED_PREVIEW_SPREADSHEET_MIME_TYPES.has(detectedMime);
        const strictNoFrame = isTextLike || isSpreadsheet;

        reply.header("Content-Type", isTextLike ? `${detectedMime}; charset=utf-8` : detectedMime);
        reply.header("Content-Disposition", `inline; filename="${safeInlineName}"`);
        if (downloaded.metadata.contentLength > 0) {
          reply.header("Content-Length", String(downloaded.metadata.contentLength));
        }
        reply.header(
          "Content-Security-Policy",
          strictNoFrame
            ? "default-src 'none'; frame-ancestors 'none'"
            : "default-src 'none'; img-src 'self'; object-src 'self'; frame-ancestors 'self'",
        );
        reply.header("X-Frame-Options", strictNoFrame ? "DENY" : "SAMEORIGIN");
        return reply.status(200).send(downloaded.body);
      } catch (error) {
        if (error instanceof OfficePreviewConversionError) {
          const statusCode =
            error.code === "CONVERSION_TIMEOUT"
              ? 504
              : error.code === "CONVERTER_UNAVAILABLE"
                ? 503
                : 422;
          return reply.status(statusCode).send({
            error: {
              code: error.code,
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
        return handleShareError(error, request, reply);
      }
    },
  );

  app.get<{ Params: { token: string } }>(
    `${CONTRACTS_API_PREFIX}/share/:token/download`,
    async (request, reply) => {
      applyPublicNoIndexHeaders(reply);
      const rawUnlock = request.headers[SHARE_UNLOCK_HEADER_NAME];
      const unlockToken = typeof rawUnlock === "string" ? rawUnlock : undefined;

      try {
        const deliveryTarget = await shareService.consumeForDelivery({
          rawToken: request.params.token,
          delivery: "DOWNLOAD",
          unlockToken,
          requestId: request.id,
          ipAddress: request.ip,
        });

        const { fileObject, organizationId } = deliveryTarget;
        const connection = await storageConnections.findById(fileObject.storageConnectionId);
        if (
          !connection ||
          connection.organizationId !== organizationId ||
          connection.status !== "ACTIVE"
        ) {
          return reply.status(503).send({
            error: {
              code: "STORAGE_UNAVAILABLE",
              message: "Conexão de armazenamento indisponível para download.",
              requestId: request.id,
            },
          });
        }

        const provider = await storageRegistry.resolveProvider(connection);
        assertStorageCapability(provider, "streamingRead");
        const downloaded = await provider.getObject({ value: fileObject.objectKey });

        const returnedChecksum = downloaded.metadata.checksumSha256.trim().toLowerCase();
        if (
          SHA256_HEX_REGEX.test(returnedChecksum) &&
          returnedChecksum !== ALL_ZERO_SHA256 &&
          returnedChecksum !== fileObject.checksumSha256.toLowerCase()
        ) {
          downloaded.body.destroy();
          return reply.status(409).send({
            error: {
              code: "CONFLICT",
              message: "Falha de integridade ao ler o arquivo compartilhado.",
              requestId: request.id,
            },
          });
        }

        const safeFileName = sanitizeDownloadFileName(fileObject.originalFileName);
        reply.header("Content-Type", fileObject.detectedContentType);
        reply.header("Content-Disposition", `attachment; filename="${safeFileName}"`);
        reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        reply.header("X-Frame-Options", "DENY");
        if (downloaded.metadata.contentLength > 0) {
          reply.header("Content-Length", String(downloaded.metadata.contentLength));
        }

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
        return handleShareError(error, request, reply);
      }
    },
  );
}
