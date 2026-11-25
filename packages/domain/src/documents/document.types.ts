import type { CategoryTextIndexingMode } from "../categories/category.types.js";

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

export interface DocumentListItemEntity {
  readonly id: string;
  readonly title: string;
  readonly categoryId: string;
  readonly folderId: string | null;
  readonly status: DocumentStatus;
  readonly currentVersionId: string | null;
  readonly ownerUserId: string;
  readonly issueDate: string | null;
  readonly expirationDate: string | null;
  readonly version: number;
  readonly contentSnippet?: string | null | undefined;
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

export interface DocumentDetailCategoryFieldSummary {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly type: "TEXT" | "NUMBER" | "DATE" | "BOOLEAN" | "SINGLE_SELECT" | "MULTI_SELECT";
  readonly required: boolean;
  readonly options?: readonly string[] | undefined;
  readonly sortOrder: number;
}

export interface DocumentDetailQueryData {
  readonly category: {
    readonly id: string;
    readonly name: string;
    readonly color: string | null;
    readonly icon: string | null;
    readonly textIndexingMode: CategoryTextIndexingMode;
    readonly fields: readonly DocumentDetailCategoryFieldSummary[];
  };
  readonly folder: {
    readonly id: string;
    readonly name: string;
    readonly materializedPath: string;
  } | null;
  readonly owner: {
    readonly id: string;
    readonly fullName: string;
    readonly email: string;
  };
  readonly currentVersion: {
    readonly id: string;
    readonly versionNumber: number;
    readonly fileObjectId: string;
    readonly uploadedByUserId: string;
    readonly changeNote: string | null;
    readonly createdAt: string;
    readonly fileObject: {
      readonly id: string;
      readonly originalFileName: string;
      readonly detectedContentType: string;
      readonly sizeBytes: number;
      readonly checksumSha256: string;
      readonly status: FileObjectStatus;
    } | null;
  } | null;
  readonly tags: readonly {
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    readonly normalizedName: string;
    readonly color: string | null;
    readonly createdAt: string;
  }[];
}

export interface DocumentVersionHistoryQueryItem {
  readonly id: string;
  readonly documentId: string;
  readonly versionNumber: number;
  readonly fileObjectId: string;
  readonly uploadedByUserId: string;
  readonly uploadedByUser: {
    readonly id: string;
    readonly fullName: string;
    readonly email: string;
  };
  readonly changeNote: string | null;
  readonly createdAt: string;
  readonly fileObject: {
    readonly id: string;
    readonly originalFileName: string;
    readonly detectedContentType: string;
    readonly sizeBytes: number;
    readonly checksumSha256: string;
    readonly status: FileObjectStatus;
  } | null;
}
