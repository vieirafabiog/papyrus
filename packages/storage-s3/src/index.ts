import { STORAGE_CORE_VERSION } from "@papyrus/storage-core";

export const S3_STORAGE_PROVIDER_KIND = "s3" as const;
export const S3_STORAGE_CORE_VERSION = STORAGE_CORE_VERSION;

export {
  checkS3StorageHealth,
  type S3HealthCheckOptions,
  type S3HealthCommandExecutor,
} from "./s3-health.js";

export {
  createS3SignedTargets,
  DEFAULT_MAX_SIGNED_EXPIRATION_SECONDS,
  DEFAULT_MIN_SIGNED_EXPIRATION_SECONDS,
  type S3PresignFunction,
  type S3SignedTargetsOptions,
  type S3SignedTargetsService,
  sanitizeDownloadFilename,
} from "./signed-targets.js";

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
