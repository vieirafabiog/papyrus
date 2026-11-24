import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  type SignedDownloadTargetInput,
  type SignedStorageTarget,
  type SignedUploadTargetInput,
  StorageError,
  normalizeStorageError,
} from "@papyrus/storage-core";
import type { S3StorageConfig } from "./s3-config.schema.js";

export const DEFAULT_MIN_SIGNED_EXPIRATION_SECONDS = 10;
export const DEFAULT_MAX_SIGNED_EXPIRATION_SECONDS = 900;

export type S3PresignFunction = (
  client: S3Client,
  command: PutObjectCommand | GetObjectCommand,
  options: {
    readonly expiresIn: number;
    readonly signableHeaders?: Set<string>;
  },
) => Promise<string>;

export interface S3SignedTargetsOptions {
  readonly minExpiresInSeconds?: number | undefined;
  readonly maxExpiresInSeconds?: number | undefined;
  readonly maxUploadBytes?: number | undefined;
  readonly normalizeKey?: ((rawKey: string, keyPrefix?: string) => string) | undefined;
  readonly presign?: S3PresignFunction | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface S3SignedTargetsService {
  createSignedUploadTarget(input: SignedUploadTargetInput): Promise<SignedStorageTarget>;
  createSignedDownloadTarget(input: SignedDownloadTargetInput): Promise<SignedStorageTarget>;
}

const DEFAULT_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function defaultNormalizeKey(rawKey: string, keyPrefix?: string): string {
  if (
    typeof rawKey !== "string" ||
    rawKey.length === 0 ||
    rawKey.length > 512 ||
    rawKey.trim() !== rawKey ||
    rawKey.includes("\\") ||
    rawKey.startsWith("/") ||
    rawKey.endsWith("/")
  ) {
    throw new StorageError(
      "INVALID_KEY",
      "Chave de objeto inválida para assinatura temporária S3.",
      "s3",
    );
  }

  for (let i = 0; i < rawKey.length; i += 1) {
    const code = rawKey.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      throw new StorageError(
        "INVALID_KEY",
        "Chave de objeto contém caracteres de controle não permitidos.",
        "s3",
      );
    }
  }

  const segments = rawKey.split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      !DEFAULT_KEY_SEGMENT_PATTERN.test(segment)
    ) {
      throw new StorageError(
        "INVALID_KEY",
        "Chave de objeto contém segmento inválido para assinatura temporária.",
        "s3",
      );
    }
  }

  const logical = segments.join("/");
  return keyPrefix ? `${keyPrefix}/${logical}` : logical;
}

export function sanitizeDownloadFilename(rawName: string): string {
  const baseName = rawName.split(/[/\\]/).pop() ?? "";
  let clean = "";
  for (let i = 0; i < baseName.length; i += 1) {
    const char = baseName[i];
    const code = baseName.charCodeAt(i);
    if (!char || code <= 0x1f || code === 0x7f || char === '"' || char === ";") {
      continue;
    }
    clean += char;
  }
  const trimmed = clean.trim().slice(0, 180);
  return trimmed.length > 0 ? trimmed : "documento";
}

function validateExpirationSeconds(
  expiresInSeconds: number,
  minSeconds: number,
  maxSeconds: number,
): number {
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < minSeconds ||
    expiresInSeconds > maxSeconds
  ) {
    throw new StorageError(
      "CONFLICT",
      `Validade da URL assinada deve estar entre ${minSeconds} e ${maxSeconds} segundos.`,
      "s3",
    );
  }
  return expiresInSeconds;
}

function validateContentType(rawContentType: string): string {
  const trimmed = rawContentType.trim();
  if (trimmed.length === 0 || trimmed.length > 255 || /[\r\n]/.test(trimmed)) {
    throw new StorageError(
      "INVALID_KEY",
      "Content-Type inválido para geração de URL assinada de upload.",
      "s3",
    );
  }
  return trimmed;
}

function assertNoSecretExposure(signedUrl: string, config: S3StorageConfig): void {
  if (
    signedUrl.includes(config.credentials.secretAccessKey) ||
    (config.credentials.sessionToken && signedUrl.includes(config.credentials.sessionToken))
  ) {
    throw new StorageError(
      "UNAUTHORIZED",
      "Falha de segurança: URL assinada não pode conter credenciais secretas.",
      "s3",
    );
  }
}

/**
 * Creates short-lived, single-object, single-method S3 presigned URLs without
 * exposing permanent storage credentials or permitting client-chosen keys.
 */
export function createS3SignedTargets(
  client: S3Client,
  config: S3StorageConfig,
  options: S3SignedTargetsOptions = {},
): S3SignedTargetsService {
  const minExpires = options.minExpiresInSeconds ?? DEFAULT_MIN_SIGNED_EXPIRATION_SECONDS;
  const maxExpires = options.maxExpiresInSeconds ?? DEFAULT_MAX_SIGNED_EXPIRATION_SECONDS;
  const normalizeKey = options.normalizeKey ?? defaultNormalizeKey;
  const presign: S3PresignFunction =
    options.presign ?? ((c, cmd, args) => getSignedUrl(c, cmd, args));
  const now = options.now ?? (() => new Date());

  return {
    async createSignedUploadTarget(input: SignedUploadTargetInput): Promise<SignedStorageTarget> {
      const expiresIn = validateExpirationSeconds(input.expiresInSeconds, minExpires, maxExpires);
      const bucketKey = normalizeKey(input.key.value, config.keyPrefix);
      const contentType = validateContentType(input.contentType);

      if (!Number.isInteger(input.contentLength) || input.contentLength < 0) {
        throw new StorageError(
          "CONFLICT",
          "Tamanho declarado inválido para assinatura temporária de upload.",
          "s3",
        );
      }

      if (options.maxUploadBytes !== undefined && input.contentLength > options.maxUploadBytes) {
        throw new StorageError(
          "CONFLICT",
          "Tamanho declarado excede o limite permitido para upload direto assinado.",
          "s3",
        );
      }

      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: bucketKey,
        ContentType: contentType,
        ContentLength: input.contentLength,
      });

      try {
        const url = await presign(client, command, {
          expiresIn,
          signableHeaders: new Set(["content-type", "content-length"]),
        });
        assertNoSecretExposure(url, config);

        return {
          url,
          method: "PUT",
          headers: {
            "content-type": contentType,
            "content-length": String(input.contentLength),
          },
          expiresAt: new Date(now().getTime() + expiresIn * 1000),
        };
      } catch (error) {
        if (error instanceof StorageError) {
          throw error;
        }
        throw normalizeStorageError(error, "s3");
      }
    },

    async createSignedDownloadTarget(
      input: SignedDownloadTargetInput,
    ): Promise<SignedStorageTarget> {
      const expiresIn = validateExpirationSeconds(input.expiresInSeconds, minExpires, maxExpires);
      const bucketKey = normalizeKey(input.key.value, config.keyPrefix);

      const disposition = input.downloadName
        ? `attachment; filename="${sanitizeDownloadFilename(input.downloadName)}"`
        : undefined;

      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: bucketKey,
        ResponseCacheControl: "private, no-store",
        ...(disposition ? { ResponseContentDisposition: disposition } : {}),
      });

      try {
        const url = await presign(client, command, { expiresIn });
        assertNoSecretExposure(url, config);

        return {
          url,
          method: "GET",
          headers: {},
          expiresAt: new Date(now().getTime() + expiresIn * 1000),
        };
      } catch (error) {
        if (error instanceof StorageError) {
          throw error;
        }
        throw normalizeStorageError(error, "s3");
      }
    },
  };
}
