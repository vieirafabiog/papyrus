import type {
  SignedDownloadTargetInput,
  SignedStorageTarget,
  SignedUploadTargetInput,
  StorageCapabilities,
  StorageDownload,
  StorageHealthCheckResult,
  StorageObjectKey,
  StorageProviderKind,
  StorageUploadInput,
  StoredObject,
} from "./storage.types.js";

export interface StorageProvider {
  readonly kind: StorageProviderKind;
  readonly capabilities: StorageCapabilities;
  checkHealth(): Promise<StorageHealthCheckResult>;
  putObject(input: StorageUploadInput): Promise<StoredObject>;
  getObject(key: StorageObjectKey): Promise<StorageDownload>;
  headObject(key: StorageObjectKey): Promise<StoredObject | null>;
  deleteObject(key: StorageObjectKey): Promise<void>;
  createSignedUploadTarget?(input: SignedUploadTargetInput): Promise<SignedStorageTarget>;
  createSignedDownloadTarget?(input: SignedDownloadTargetInput): Promise<SignedStorageTarget>;
}
