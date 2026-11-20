import type {
  StorageConnectionEntity,
  StorageConnectionHealthOutput,
  StorageConnectionHealthTesterPort,
} from "@docuflow/domain";
import { type StorageSecretVault, createStorageProviderRegistry } from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";
import { type S3EndpointSecurityPolicy, createS3StorageProvider } from "@docuflow/storage-s3";

function readNonEmptyString(value: string | number | boolean | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalBoolean(
  value: string | number | boolean | null | undefined,
  fallback: boolean,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalPositiveNumber(
  value: string | number | boolean | null | undefined,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

export interface StorageHealthTesterOptions {
  readonly secretVault?: StorageSecretVault | undefined;
  readonly s3SecurityPolicy?: S3EndpointSecurityPolicy | undefined;
  readonly healthVerifyReadWrite?: boolean | undefined;
}

/**
 * Bridges domain `StorageConnectionHealthTesterPort` to the concrete storage
 * provider registry (`local` filesystem and `s3`-compatible endpoints).
 */
export function createStorageHealthTester(
  options: StorageHealthTesterOptions = {},
): StorageConnectionHealthTesterPort {
  const registry = createStorageProviderRegistry({
    secretResolver: options.secretVault?.toStorageSecretResolver(),
  });

  registry.registerFactory("local", ({ connection }) => {
    const rootDirectory = readNonEmptyString(connection.nonSecretConfig.rootDirectory);
    if (!rootDirectory) {
      throw new Error("Local rootDirectory is missing");
    }
    return createLocalStorageProvider({
      rootDirectory,
      maxObjectSizeBytes: readOptionalPositiveNumber(connection.nonSecretConfig.maxObjectSizeBytes),
      minFreeBytes: readOptionalPositiveNumber(connection.nonSecretConfig.minFreeBytes),
    });
  });

  registry.registerFactory("s3", ({ connection, resolvedSecret }) => {
    const endpoint = readNonEmptyString(connection.nonSecretConfig.endpoint);
    const region = readNonEmptyString(connection.nonSecretConfig.region);
    const bucket = readNonEmptyString(connection.nonSecretConfig.bucket);
    const accessKeyId = resolvedSecret?.accessKeyId;
    const secretAccessKey = resolvedSecret?.secretAccessKey;

    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error("S3 configuration or decrypted credentials are missing");
    }

    const keyPrefix = readNonEmptyString(connection.nonSecretConfig.keyPrefix) ?? undefined;
    const forcePathStyle = readOptionalBoolean(connection.nonSecretConfig.forcePathStyle, false);
    const rejectUnauthorized = readOptionalBoolean(
      connection.nonSecretConfig.tlsRejectUnauthorized,
      true,
    );
    const allowInsecureHttp = readOptionalBoolean(
      connection.nonSecretConfig.tlsAllowInsecureHttp,
      false,
    );
    const caCertificatePem =
      readNonEmptyString(connection.nonSecretConfig.caCertificatePem) ?? undefined;
    const connectionTimeoutMs =
      readOptionalPositiveNumber(connection.nonSecretConfig.connectionTimeoutMs) ?? 5_000;
    const requestTimeoutMs =
      readOptionalPositiveNumber(connection.nonSecretConfig.requestTimeoutMs) ?? 30_000;

    return createS3StorageProvider(
      {
        endpoint,
        region,
        bucket,
        forcePathStyle,
        ...(keyPrefix ? { keyPrefix } : {}),
        tls: {
          rejectUnauthorized,
          allowInsecureHttp,
          ...(caCertificatePem ? { caCertificatePem } : {}),
        },
        credentials: {
          accessKeyId,
          secretAccessKey,
          ...(resolvedSecret.sessionToken ? { sessionToken: resolvedSecret.sessionToken } : {}),
        },
        timeouts: {
          connectionTimeoutMs,
          requestTimeoutMs,
        },
      },
      {
        securityPolicy: options.s3SecurityPolicy,
        healthVerifyReadWrite: options.healthVerifyReadWrite,
      },
    );
  });

  return {
    async testConnection(
      connection: StorageConnectionEntity,
    ): Promise<StorageConnectionHealthOutput> {
      try {
        const provider = await registry.resolveProvider(connection, {
          allowInactive: true,
          bypassCache: true,
        });
        return await provider.checkHealth();
      } catch {
        return {
          healthy: false,
          message: "Falha ao verificar a saúde da conexão de armazenamento.",
          checkedAt: new Date(),
        };
      }
    },
  };
}

export function createLocalStorageHealthTester(): StorageConnectionHealthTesterPort {
  return createStorageHealthTester();
}
