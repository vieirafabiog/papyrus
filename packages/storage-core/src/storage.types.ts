import type { Readable } from "node:stream";

export type StorageProviderKind = "local" | "s3" | "sharepoint" | "azure_blob" | "google_cloud";

export interface StorageObjectKey {
  readonly value: string;
}

export interface StorageObjectMetadata {
  readonly contentType: string;
  readonly contentLength: number;
  readonly checksumSha256: string;
  readonly customMetadata?: Readonly<Record<string, string>> | undefined;
}

export interface StoredObject extends StorageObjectMetadata {
  readonly key: StorageObjectKey;
  readonly etag?: string | undefined;
  readonly providerVersionId?: string | undefined;
}

export interface StorageCapabilities {
  readonly streamingRead: boolean;
  readonly streamingWrite: boolean;
  readonly signedUpload: boolean;
  readonly signedDownload: boolean;
  readonly multipartUpload: boolean;
  readonly serverSideCopy: boolean;
}

export interface StorageUploadInput {
  readonly key: StorageObjectKey;
  readonly body: Readable;
  readonly metadata: StorageObjectMetadata;
  readonly abortSignal?: AbortSignal | undefined;
}

export interface StorageDownload {
  readonly body: Readable;
  readonly metadata: StorageObjectMetadata;
}

export interface SignedStorageTarget {
  readonly url: string;
  readonly method: "PUT" | "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface StorageHealthCheckResult {
  readonly healthy: boolean;
  readonly message: string;
  readonly checkedAt: Date;
}

export interface SignedUploadTargetInput {
  readonly key: StorageObjectKey;
  readonly contentType: string;
  readonly contentLength: number;
  readonly expiresInSeconds: number;
}

export interface SignedDownloadTargetInput {
  readonly key: StorageObjectKey;
  readonly expiresInSeconds: number;
  readonly downloadName?: string | undefined;
}
