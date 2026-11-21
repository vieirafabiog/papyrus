import type {
  AuthorizedCategoryQueryScope,
  CategoryEntity,
  CategoryListFilter,
} from "../categories/category.types.js";
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
}
