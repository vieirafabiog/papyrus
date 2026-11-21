import type {
  AuthorizedFolderQueryScope,
  FolderEntity,
  FolderListFilter,
} from "../folders/folder.types.js";
import type { PaginatedResult } from "./document-repository.port.js";
import type { TransactionContext } from "./transaction.port.js";

export interface CreateFolderInput {
  readonly id: string;
  readonly organizationId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly materializedPath: string;
  readonly createdBy: string;
}

export interface RenameFolderInput {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly updatedBy: string;
}

export interface MoveFolderSubtreeInput {
  readonly organizationId: string;
  readonly folderId: string;
  readonly newParentId: string | null;
  readonly oldMaterializedPath: string;
  readonly newMaterializedPath: string;
  readonly updatedBy: string;
}

export interface ArchiveFolderInput {
  readonly id: string;
  readonly organizationId: string;
  readonly updatedBy: string;
}

export interface FolderRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<FolderEntity | null>;
  findByNameInParent(
    organizationId: string,
    parentId: string | null,
    name: string,
    tx?: TransactionContext,
  ): Promise<FolderEntity | null>;
  listAncestorIds(
    organizationId: string,
    folderId: string,
    tx?: TransactionContext,
  ): Promise<readonly string[]>;
  hasActiveChildren(
    organizationId: string,
    folderId: string,
    tx?: TransactionContext,
  ): Promise<boolean>;
  listAuthorized(
    filter: FolderListFilter,
    scope: AuthorizedFolderQueryScope,
  ): Promise<PaginatedResult<FolderEntity>>;
  create(input: CreateFolderInput, tx?: TransactionContext): Promise<FolderEntity>;
  rename(input: RenameFolderInput, tx?: TransactionContext): Promise<FolderEntity | null>;
  moveSubtree(input: MoveFolderSubtreeInput, tx?: TransactionContext): Promise<FolderEntity | null>;
  archive(input: ArchiveFolderInput, tx?: TransactionContext): Promise<FolderEntity | null>;
}
