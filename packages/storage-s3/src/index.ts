import { STORAGE_CORE_VERSION } from "@docuflow/storage-core";

export const S3_STORAGE_PROVIDER_KIND = "s3" as const;
export const S3_STORAGE_CORE_VERSION = STORAGE_CORE_VERSION;

export {
  createS3StorageProvider,
  normalizeS3ObjectKey,
  type S3ChecksumSupportMode,
  type S3CommandExecutor,
  type S3StorageProviderOptions,
  type S3SupportedCommand,
} from "./s3-storage-provider.js";

export {
  createS3StorageConfigSchema,
  type DnsLookupAllFn,
  isRestrictedIpAddress,
  parseS3StorageConfig,
  type S3EndpointSecurityPolicy,
  type S3StorageConfig,
  type S3StorageConfigInput,
  s3BucketSchema,
  s3CredentialsSchema,
  s3RegionSchema,
  s3StorageConfigSchema,
  s3TimeoutsSchema,
  s3TlsConfigSchema,
  type SanitizedS3ConfigSummary,
  sanitizeS3ConfigSummary,
  validateS3EndpointResolution,
  validateS3EndpointUrl,
} from "./s3-config.schema.js";
