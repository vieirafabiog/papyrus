import type { TagEntity, TagListFilter } from "../tags/tag.types.js";
import type { PaginatedResult } from "./document-repository.port.js";
import type { TransactionContext } from "./transaction.port.js";

export interface CreateTagRecordInput {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly color: string | null;
  readonly createdBy: string;
}

export interface AttachDocumentTagRecordInput {
  readonly id: string;
  readonly documentId: string;
  readonly tagId: string;
  readonly createdBy: string;
}

export interface TagRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<TagEntity | null>;
  findByNormalizedName(
    organizationId: string,
    normalizedName: string,
    tx?: TransactionContext,
  ): Promise<TagEntity | null>;
  list(filter: TagListFilter): Promise<PaginatedResult<TagEntity>>;
  create(input: CreateTagRecordInput, tx?: TransactionContext): Promise<TagEntity>;
  listDocumentTags(
    organizationId: string,
    documentId: string,
    tx?: TransactionContext,
  ): Promise<readonly TagEntity[]>;
  isAttachedToDocument(
    documentId: string,
    tagId: string,
    tx?: TransactionContext,
  ): Promise<boolean>;
  attachToDocument(input: AttachDocumentTagRecordInput, tx?: TransactionContext): Promise<void>;
  detachFromDocument(documentId: string, tagId: string, tx?: TransactionContext): Promise<boolean>;
}
