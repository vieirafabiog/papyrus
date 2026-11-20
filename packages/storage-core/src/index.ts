export const STORAGE_CORE_VERSION = 1 as const;

export {
  normalizeStorageError,
  sanitizeStorageErrorMessage,
  StorageError,
  type StorageErrorCode,
} from "./storage.errors.js";

export type {
  SignedDownloadTargetInput,
  SignedStorageTarget,
  SignedUploadTargetInput,
  StorageCapabilities,
  StorageDownload,
  StorageHealthCheckResult,
  StorageObjectKey,
  StorageObjectMetadata,
  StorageProviderKind,
  StorageUploadInput,
  StoredObject,
} from "./storage.types.js";

export type { StorageProvider } from "./storage-provider.js";

export {
  createStorageProviderRegistry,
  type RegisterFactoryOptions,
  type RegistryConnectionStatus,
  type RegistryNonSecretConfig,
  type ResolveStorageProviderOptions,
  type StorageConnectionDescriptor,
  type StorageConnectionLookup,
  type StorageProviderFactory,
  type StorageProviderFactoryContext,
  type StorageProviderRegistry,
  type StorageProviderRegistryOptions,
  type StorageSecretResolver,
} from "./storage-registry.js";
