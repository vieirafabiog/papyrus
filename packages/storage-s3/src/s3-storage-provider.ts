import { createHash } from "node:crypto";
import https from "node:https";
import { Readable, Transform } from "node:stream";
import { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  type StorageCapabilities,
  type StorageDownload,
  StorageError,
  type StorageObjectKey,
  type StorageObjectMetadata,
  type StorageProvider,
  type StorageUploadInput,
  type StoredObject,
  normalizeStorageError,
} from "@docuflow/storage-core";
import {
  type DnsLookupAllFn,
  type S3EndpointSecurityPolicy,
  type S3StorageConfig,
  type S3StorageConfigInput,
  parseS3StorageConfig,
  validateS3EndpointResolution,
} from "./s3-config.schema.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const DOCUFLOW_SHA256_META_KEY = "docuflow-sha256";
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface S3StorageProviderOptions {
  readonly securityPolicy?: S3EndpointSecurityPolicy | undefined;
  readonly dnsLookup?: DnsLookupAllFn | undefined;
  readonly client?: S3Client | undefined;
}

const S3_STREAMING_CAPABILITIES: StorageCapabilities = {
  streamingRead: true,
  streamingWrite: true,
  signedUpload: false,
  signedDownload: false,
  multipartUpload: false,
  serverSideCopy: false,
};

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function normalizeS3ObjectKey(
  rawKey: string,
  keyPrefix?: string,
): {
  readonly logicalKey: string;
  readonly bucketKey: string;
} {
  if (
    typeof rawKey !== "string" ||
    rawKey.length === 0 ||
    rawKey.length > 512 ||
    rawKey.trim() !== rawKey ||
    hasControlChars(rawKey) ||
    rawKey.includes("\\") ||
    rawKey.startsWith("/") ||
    rawKey.endsWith("/")
  ) {
    throw new StorageError("INVALID_KEY", "Chave de objeto inválida para armazenamento S3.", "s3");
  }

  const segments = rawKey.split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      !SAFE_SEGMENT_PATTERN.test(segment)
    ) {
      throw new StorageError(
        "INVALID_KEY",
        "Chave de objeto S3 contém segmento inválido ou proibido.",
        "s3",
      );
    }
  }

  const logicalKey = segments.join("/");
  const bucketKey = keyPrefix ? `${keyPrefix}/${logicalKey}` : logicalKey;
  return { logicalKey, bucketKey };
}

function createConfiguredS3Client(config: S3StorageConfig): S3Client {
  const endpointUrl = new URL(config.endpoint);
  const httpsAgent =
    endpointUrl.protocol === "https:"
      ? new https.Agent({
          rejectUnauthorized: config.tls.rejectUnauthorized,
          ...(config.tls.caCertificatePem ? { ca: config.tls.caCertificatePem } : {}),
        })
      : undefined;

  const clientConfig: S3ClientConfig = {
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.credentials.accessKeyId,
      secretAccessKey: config.credentials.secretAccessKey,
      ...(config.credentials.sessionToken ? { sessionToken: config.credentials.sessionToken } : {}),
    },
    requestHandler: {
      connectionTimeout: config.timeouts.connectionTimeoutMs,
      requestTimeout: config.timeouts.requestTimeoutMs,
      ...(httpsAgent ? { httpsAgent } : {}),
    },
  };

  return new S3Client(clientConfig);
}

function buildS3UserMetadata(
  checksumSha256: string,
  customMetadata?: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {
    [DOCUFLOW_SHA256_META_KEY]: checksumSha256,
  };
  if (customMetadata) {
    for (const [k, v] of Object.entries(customMetadata)) {
      const normalizedKey = k.trim().toLowerCase();
      if (normalizedKey.length > 0 && normalizedKey !== DOCUFLOW_SHA256_META_KEY) {
        result[normalizedKey] = v;
      }
    }
  }
  return result;
}

function extractCustomMetadata(
  rawMetadata: Record<string, string> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!rawMetadata) {
    return undefined;
  }
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawMetadata)) {
    if (k.toLowerCase() !== DOCUFLOW_SHA256_META_KEY) {
      filtered[k] = v;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function base64ChecksumToHex(base64Checksum: string | undefined): string | undefined {
  if (!base64Checksum) {
    return undefined;
  }
  const decoded = Buffer.from(base64Checksum, "base64");
  if (decoded.length !== 32) {
    return undefined;
  }
  return decoded.toString("hex");
}

function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) {
    return body;
  }
  if (body instanceof WebReadableStream) {
    return Readable.fromWeb(body);
  }
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToWebStream" in body &&
    typeof (body as { transformToWebStream: unknown }).transformToWebStream === "function"
  ) {
    const webStream = (
      body as { transformToWebStream: () => WebReadableStream }
    ).transformToWebStream();
    return Readable.fromWeb(webStream);
  }
  throw new StorageError(
    "UNAVAILABLE",
    "Resposta de streaming do provedor S3 não retornou um stream legível.",
    "s3",
  );
}

function createOperationSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new Error("S3 request timeout"));
  }, timeoutMs);

  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutController.signal])
    : timeoutController.signal;

  return {
    signal,
    cleanup: () => {
      clearTimeout(timer);
    },
  };
}

export function createS3StorageProvider(
  rawConfig: S3StorageConfigInput,
  options: S3StorageProviderOptions = {},
): StorageProvider {
  const config = parseS3StorageConfig(rawConfig, options.securityPolicy);
  const effectivePolicy: S3EndpointSecurityPolicy = {
    ...options.securityPolicy,
    allowInsecureHttp: options.securityPolicy?.allowInsecureHttp ?? config.tls.allowInsecureHttp,
  };
  const client = options.client ?? createConfiguredS3Client(config);

  const ensureEndpointResolutionSafe = async (): Promise<void> => {
    await validateS3EndpointResolution(config.endpoint, effectivePolicy, options.dnsLookup);
  };

  return {
    kind: "s3",
    capabilities: S3_STREAMING_CAPABILITIES,

    async checkHealth() {
      throw new StorageError(
        "CAPABILITY_NOT_SUPPORTED",
        "Verificação de saúde S3 ainda não habilitada nesta versão do provedor.",
        "s3",
      );
    },

    async putObject(input: StorageUploadInput): Promise<StoredObject> {
      if (input.abortSignal?.aborted) {
        input.body.destroy();
        throw new StorageError(
          "TIMEOUT",
          "Operação de escrita S3 cancelada antes do início do envio.",
          "s3",
        );
      }

      if (!Number.isInteger(input.metadata.contentLength) || input.metadata.contentLength < 0) {
        throw new StorageError(
          "CONFLICT",
          "Tamanho declarado do objeto é inválido para armazenamento S3.",
          "s3",
        );
      }

      const expectedChecksum = input.metadata.checksumSha256.trim().toLowerCase();
      if (!SHA256_HEX_PATTERN.test(expectedChecksum)) {
        throw new StorageError(
          "CHECKSUM_MISMATCH",
          "Checksum SHA-256 esperado possui formato inválido.",
          "s3",
        );
      }

      const { logicalKey, bucketKey } = normalizeS3ObjectKey(input.key.value, config.keyPrefix);
      await ensureEndpointResolutionSafe();

      const hasher = createHash("sha256");
      let bytesStreamed = 0;

      const inspectionStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesStreamed += chunk.length;
          hasher.update(chunk);
          callback(null, chunk);
        },
      });

      const pipedBody = input.body.pipe(inspectionStream);
      const { signal, cleanup } = createOperationSignal(
        config.timeouts.requestTimeoutMs,
        input.abortSignal,
      );

      try {
        const command = new PutObjectCommand({
          Bucket: config.bucket,
          Key: bucketKey,
          Body: pipedBody,
          ContentType: input.metadata.contentType,
          ContentLength: input.metadata.contentLength,
          Metadata: buildS3UserMetadata(expectedChecksum, input.metadata.customMetadata),
        });

        const output = await client.send(command, { abortSignal: signal });

        const computedChecksum = hasher.digest("hex");
        if (
          bytesStreamed !== input.metadata.contentLength ||
          computedChecksum !== expectedChecksum
        ) {
          // Best-effort cleanup if uploaded stream diverged from declared length/checksum
          await client
            .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: bucketKey }))
            .catch(() => undefined);
          throw new StorageError(
            "CHECKSUM_MISMATCH",
            "Tamanho ou checksum SHA-256 do stream enviado diverge do esperado.",
            "s3",
          );
        }

        return {
          key: { value: logicalKey },
          contentType: input.metadata.contentType,
          contentLength: bytesStreamed,
          checksumSha256: computedChecksum,
          customMetadata: input.metadata.customMetadata,
          ...(output.ETag ? { etag: output.ETag.replaceAll('"', "") } : {}),
          ...(output.VersionId ? { providerVersionId: output.VersionId } : {}),
        };
      } catch (error) {
        input.body.destroy();
        inspectionStream.destroy();
        if (error instanceof StorageError) {
          throw error;
        }
        throw normalizeStorageError(error, "s3");
      } finally {
        cleanup();
      }
    },

    async getObject(key: StorageObjectKey): Promise<StorageDownload> {
      const { bucketKey } = normalizeS3ObjectKey(key.value, config.keyPrefix);
      await ensureEndpointResolutionSafe();

      const { signal, cleanup } = createOperationSignal(config.timeouts.requestTimeoutMs);

      try {
        const output = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: bucketKey,
          }),
          { abortSignal: signal },
        );

        const body = toNodeReadable(output.Body);
        const rawMeta = output.Metadata;
        const checksumFromHeader = base64ChecksumToHex(output.ChecksumSHA256);
        const checksumFromMeta = rawMeta?.[DOCUFLOW_SHA256_META_KEY]?.toLowerCase();
        const resolvedChecksum =
          checksumFromHeader ??
          (checksumFromMeta && SHA256_HEX_PATTERN.test(checksumFromMeta)
            ? checksumFromMeta
            : "0".repeat(64));

        const metadata: StorageObjectMetadata = {
          contentType: output.ContentType ?? "application/octet-stream",
          contentLength: output.ContentLength ?? 0,
          checksumSha256: resolvedChecksum,
          customMetadata: extractCustomMetadata(rawMeta),
        };

        return { body, metadata };
      } catch (error) {
        if (error instanceof StorageError) {
          throw error;
        }
        throw normalizeStorageError(error, "s3");
      } finally {
        cleanup();
      }
    },

    async headObject() {
      throw new StorageError(
        "CAPABILITY_NOT_SUPPORTED",
        "Inspeção HEAD S3 ainda não habilitada nesta versão do provedor.",
        "s3",
      );
    },

    async deleteObject() {
      throw new StorageError(
        "CAPABILITY_NOT_SUPPORTED",
        "Exclusão S3 ainda não habilitada nesta versão do provedor.",
        "s3",
      );
    },
  };
}
