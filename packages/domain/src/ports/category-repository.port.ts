import type {
  AuthorizedCategoryQueryScope,
  CategoryEntity,
  CategoryFieldEntity,
  CategoryListFilter,
} from "../categories/category.types.js";
import type { CategoryFieldType } from "../categories/metadata-validation.js";
import type { DocumentMetadataMap, DocumentMetadataValue } from "../documents/document.types.js";
import type { PaginatedResult } from "./document-repository.port.js";
import type { TransactionContext } from "./transaction.port.js";

export interface CreateCategoryInput {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly color: string | null;
  readonly icon: string | null;
  readonly createdBy: string;
}

export interface UpdateCategoryInput {
  readonly id: string;
  readonly organizationId: string;
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly color?: string | null | undefined;
  readonly icon?: string | null | undefined;
  readonly isActive?: boolean | undefined;
  readonly updatedBy: string;
}

export interface CreateCategoryFieldRecordInput {
  readonly id: string;
  readonly categoryId: string;
  readonly key: string;
  readonly label: string;
  readonly type: CategoryFieldType;
  readonly required: boolean;
  readonly options: readonly string[] | null;
  readonly sortOrder: number;
}

export interface UpdateCategoryFieldRecordInput {
  readonly id: string;
  readonly categoryId: string;
  readonly label?: string | undefined;
  readonly type?: CategoryFieldType | undefined;
  readonly required?: boolean | undefined;
  readonly options?: readonly string[] | null | undefined;
  readonly sortOrder?: number | undefined;
}

export interface ExistingDocumentMetadataSnapshot {
  readonly documentId: string;
  readonly metadata: DocumentMetadataMap;
}

export interface CategoryRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<CategoryEntity | null>;
  findByName(
    organizationId: string,
    name: string,
    tx?: TransactionContext,
  ): Promise<CategoryEntity | null>;
  countExistingDocuments(
    organizationId: string,
    categoryId: string,
    tx?: TransactionContext,
  ): Promise<number>;
  listAuthorized(
    filter: CategoryListFilter,
    scope: AuthorizedCategoryQueryScope,
  ): Promise<PaginatedResult<CategoryEntity>>;
  create(input: CreateCategoryInput, tx?: TransactionContext): Promise<CategoryEntity>;
  update(input: UpdateCategoryInput, tx?: TransactionContext): Promise<CategoryEntity | null>;

  listFields(categoryId: string, tx?: TransactionContext): Promise<readonly CategoryFieldEntity[]>;
  findFieldById(
    categoryId: string,
    fieldId: string,
    tx?: TransactionContext,
  ): Promise<CategoryFieldEntity | null>;
  findFieldByKey(
    categoryId: string,
    key: string,
    tx?: TransactionContext,
  ): Promise<CategoryFieldEntity | null>;
  createField(
    input: CreateCategoryFieldRecordInput,
    tx?: TransactionContext,
  ): Promise<CategoryFieldEntity>;
  updateField(
    input: UpdateCategoryFieldRecordInput,
    tx?: TransactionContext,
  ): Promise<CategoryFieldEntity | null>;
  deleteField(categoryId: string, fieldId: string, tx?: TransactionContext): Promise<boolean>;
  listExistingDocumentMetadata(
    organizationId: string,
    categoryId: string,
    tx?: TransactionContext,
  ): Promise<readonly ExistingDocumentMetadataSnapshot[]>;
  backfillFieldMetadata(
    input: {
      readonly organizationId: string;
      readonly categoryId: string;
      readonly fieldId: string;
      readonly fieldKey: string;
      readonly fieldType: CategoryFieldType;
      readonly defaultValue: DocumentMetadataValue;
      readonly updatedBy: string;
    },
    tx?: TransactionContext,
  ): Promise<void>;
  resetFieldMetadata(
    input: {
      readonly organizationId: string;
      readonly categoryId: string;
      readonly fieldId: string;
      readonly fieldKey: string;
      readonly fieldType: CategoryFieldType;
      readonly defaultValue: DocumentMetadataValue;
      readonly updatedBy: string;
    },
    tx?: TransactionContext,
  ): Promise<void>;
  removeFieldMetadata(
    input: {
      readonly organizationId: string;
      readonly categoryId: string;
      readonly fieldId: string;
      readonly fieldKey: string;
      readonly updatedBy: string;
    },
    tx?: TransactionContext,
  ): Promise<void>;
}
