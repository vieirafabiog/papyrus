import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  type DeleteObjectCommandOutput,
  HeadBucketCommand,
  type HeadBucketCommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import {
  StorageError,
  type StorageHealthCheckResult,
  normalizeStorageError,
} from "@papyrus/storage-core";
import {
  type DnsLookupAllFn,
  type S3EndpointSecurityPolicy,
  type S3StorageConfig,
  validateS3EndpointResolution,
} from "./s3-config.schema.js";

export interface S3HealthCommandExecutor {
  send(
    command: HeadBucketCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<HeadBucketCommandOutput>;
  send(
    command: PutObjectCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<PutObjectCommandOutput>;
  send(
    command: DeleteObjectCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<DeleteObjectCommandOutput>;
}

export interface S3HealthCheckOptions {
  readonly client: S3HealthCommandExecutor;
  readonly config: S3StorageConfig;
  readonly securityPolicy?: S3EndpointSecurityPolicy | undefined;
  readonly dnsLookup?: DnsLookupAllFn | undefined;
  readonly verifyReadWrite?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
}

function buildProbeKey(keyPrefix?: string): string {
  const leaf = `.papyrus-health-probe-${randomUUID()}`;
  return keyPrefix ? `${keyPrefix}/${leaf}` : leaf;
}

function mapFailureToHealthResult(
  error: unknown,
  phase: "dns" | "bucket" | "probe",
  checkedAt: Date,
): StorageHealthCheckResult {
  const normalized = error instanceof StorageError ? error : normalizeStorageError(error, "s3");

  if (phase === "dns") {
    if (normalized.code === "UNAUTHORIZED") {
      return {
        healthy: false,
        message: "Endpoint S3 rejeitado pela política de segurança SSRF na resolução DNS.",
        checkedAt,
      };
    }
    return {
      healthy: false,
      message: "Não foi possível resolver o hostname do endpoint S3.",
      checkedAt,
    };
  }

  switch (normalized.code) {
    case "NOT_FOUND":
      return {
        healthy: false,
        message: "Bucket S3 configurado não foi encontrado.",
        checkedAt,
      };
    case "UNAUTHORIZED":
      return {
        healthy: false,
        message:
          phase === "probe"
            ? "Credenciais S3 sem permissão mínima de escrita/remoção no bucket."
            : "Credenciais S3 inválidas ou sem permissão mínima de acesso ao bucket.",
        checkedAt,
      };
    case "TIMEOUT":
      return {
        healthy: false,
        message: "Tempo limite excedido ao verificar a conectividade com o provedor S3.",
        checkedAt,
      };
    case "THROTTLED":
      return {
        healthy: false,
        message: "Provedor S3 limitou temporariamente a taxa de requisições na verificação.",
        checkedAt,
      };
    default:
      return {
        healthy: false,
        message: "Falha ao verificar a conectividade e permissões do bucket S3.",
        checkedAt,
      };
  }
}

/**
 * Verifies S3 endpoint safety, credentials, bucket existence, and minimal permissions
 * without unnecessarily listing bucket objects.
 */
export async function checkS3StorageHealth(
  options: S3HealthCheckOptions,
): Promise<StorageHealthCheckResult> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now();
  const effectivePolicy: S3EndpointSecurityPolicy = {
    ...options.securityPolicy,
    allowInsecureHttp:
      options.securityPolicy?.allowInsecureHttp ?? options.config.tls.allowInsecureHttp,
  };

  try {
    await validateS3EndpointResolution(options.config.endpoint, effectivePolicy, options.dnsLookup);
  } catch (error) {
    return mapFailureToHealthResult(error, "dns", checkedAt);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("S3 health check timeout"));
  }, options.config.timeouts.requestTimeoutMs);

  try {
    await options.client.send(
      new HeadBucketCommand({
        Bucket: options.config.bucket,
      }),
      { abortSignal: controller.signal },
    );
  } catch (error) {
    clearTimeout(timer);
    return mapFailureToHealthResult(error, "bucket", checkedAt);
  }

  if (options.verifyReadWrite) {
    const probeKey = buildProbeKey(options.config.keyPrefix);
    const probeBytes = Buffer.from("papyrus-s3-health-probe", "utf8");
    try {
      await options.client.send(
        new PutObjectCommand({
          Bucket: options.config.bucket,
          Key: probeKey,
          Body: probeBytes,
          ContentLength: probeBytes.length,
          ContentType: "text/plain",
        }),
        { abortSignal: controller.signal },
      );

      await options.client.send(
        new DeleteObjectCommand({
          Bucket: options.config.bucket,
          Key: probeKey,
        }),
        { abortSignal: controller.signal },
      );
    } catch (error) {
      await options.client
        .send(
          new DeleteObjectCommand({
            Bucket: options.config.bucket,
            Key: probeKey,
          }),
        )
        .catch(() => undefined);
      clearTimeout(timer);
      return mapFailureToHealthResult(error, "probe", checkedAt);
    }
  }

  clearTimeout(timer);
  return {
    healthy: true,
    message: options.verifyReadWrite
      ? "Conexão S3 operacional (credenciais, bucket e permissões de escrita verificados)."
      : "Conexão S3 operacional (credenciais e bucket verificados).",
    checkedAt,
  };
}
