import type {
  DocumentEntity,
  DocumentMetadataMap,
  DocumentStatus,
  DocumentVersionEntity,
} from "../documents/document.types.js";
import type { TransactionContext } from "./transaction.port.js";

export type DocumentSortField =
  | "title"
  | "status"
  | "issueDate"
  | "expirationDate"
  | "createdAt"
  | "updatedAt"
  | "id";

export interface DocumentListFilter {
  readonly organizationId: string;
  readonly search?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly folderId?: string | undefined;
  readonly status?: DocumentStatus | undefined;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: DocumentSortField;
  readonly sortDirection: "asc" | "desc";
}

export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface CreateDocumentInput {
  readonly id: string;
  readonly organizationId: string;
  readonly title: string;
  readonly categoryId: string;
  readonly folderId: string | null;
  readonly ownerUserId: string;
  readonly issueDate: string | null;
  readonly expirationDate: string | null;
  readonly metadata: DocumentMetadataMap;
}

export interface UpdateDocumentInput {
  readonly title?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly folderId?: string | null | undefined;
  readonly issueDate?: string | null | undefined;
  readonly expirationDate?: string | null | undefined;
  readonly metadata?: DocumentMetadataMap | undefined;
}

export interface DocumentRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<DocumentEntity | null>;
  list(filter: DocumentListFilter): Promise<PaginatedResult<DocumentEntity>>;
  create(input: CreateDocumentInput, tx?: TransactionContext): Promise<DocumentEntity>;
  updateWithOptimisticLock(
    id: string,
    expectedVersion: number,
    input: UpdateDocumentInput,
    tx?: TransactionContext,
  ): Promise<DocumentEntity | null>;
  setCurrentVersion(
    documentId: string,
    versionId: string,
    expectedVersion: number,
    tx?: TransactionContext,
  ): Promise<DocumentEntity | null>;
  updateStatus(
    documentId: string,
    status: DocumentStatus,
    expectedVersion: number,
    tx?: TransactionContext,
  ): Promise<DocumentEntity | null>;
}

export interface CreateDocumentVersionInput {
  readonly id: string;
  readonly documentId: string;
  readonly versionNumber: number;
  readonly fileObjectId: string;
  readonly uploadedByUserId: string;
  readonly changeNote: string | null;
}

export interface DocumentVersionRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<DocumentVersionEntity | null>;
  findLatestByDocumentId(
    documentId: string,
    tx?: TransactionContext,
  ): Promise<DocumentVersionEntity | null>;
  listByDocumentId(documentId: string): Promise<readonly DocumentVersionEntity[]>;
  create(input: CreateDocumentVersionInput, tx?: TransactionContext): Promise<DocumentVersionEntity>;
}
