export const DOCUMENT_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "ARCHIVED",
  "EXPIRED",
  "DELETED",
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const FILE_OBJECT_STATUSES = [
  "UPLOADING",
  "QUARANTINED",
  "AVAILABLE",
  "REJECTED",
  "MISSING",
  "DELETE_PENDING",
] as const;

export type FileObjectStatus = (typeof FILE_OBJECT_STATUSES)[number];

export type DocumentMetadataValue = string | number | boolean | null | readonly string[];

export type DocumentMetadataMap = Readonly<Record<string, DocumentMetadataValue>>;

export interface DocumentEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly title: string;
  readonly categoryId: string;
  readonly folderId: string | null;
  readonly status: DocumentStatus;
  readonly currentVersionId: string | null;
  readonly ownerUserId: string;
  readonly issueDate: string | null;
  readonly expirationDate: string | null;
  readonly metadata: DocumentMetadataMap;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentVersionEntity {
  readonly id: string;
  readonly documentId: string;
  readonly versionNumber: number;
  readonly fileObjectId: string;
  readonly uploadedByUserId: string;
  readonly changeNote: string | null;
  readonly createdAt: string;
}

export interface FileObjectEntity {
  readonly id: string;
  readonly storageConnectionId: string;
  readonly objectKey: string;
  readonly originalFileName: string;
  readonly detectedContentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly status: FileObjectStatus;
  readonly createdAt: string;
}
