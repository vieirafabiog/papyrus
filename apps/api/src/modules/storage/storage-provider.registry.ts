import {
  type StorageConnectionLookup,
  type StorageProviderRegistry,
  type StorageSecretVault,
  createStorageProviderRegistry,
} from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";
import {
  type DnsLookupAllFn,
  type S3EndpointSecurityPolicy,
  type S3SignedTargetsOptions,
  createS3StorageProvider,
} from "@docuflow/storage-s3";

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

export interface ApiStorageProviderRegistryOptions {
  readonly secretVault?: StorageSecretVault | undefined;
  readonly connectionLookup?: StorageConnectionLookup | undefined;
  readonly s3SecurityPolicy?: S3EndpointSecurityPolicy | undefined;
  readonly dnsLookup?: DnsLookupAllFn | undefined;
  readonly healthVerifyReadWrite?: boolean | undefined;
  readonly enableS3SignedTargets?: boolean | undefined;
  readonly s3SignedTargetsOptions?: S3SignedTargetsOptions | undefined;
}

/**
 * Builds the API storage provider registry wiring both local filesystem and S3-compatible
 * connectors via `@docuflow/storage-core` without exposing provider SDKs to routes or domain.
 */
export function createApiStorageProviderRegistry(
  options: ApiStorageProviderRegistryOptions = {},
): StorageProviderRegistry {
  const registry = createStorageProviderRegistry({
    secretResolver: options.secretVault?.toStorageSecretResolver(),
    connectionLookup: options.connectionLookup,
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
        dnsLookup: options.dnsLookup,
        healthVerifyReadWrite: options.healthVerifyReadWrite,
        enableSignedTargets: options.enableS3SignedTargets,
        signedTargetsOptions: options.s3SignedTargetsOptions,
      },
    );
  });

  return registry;
}
