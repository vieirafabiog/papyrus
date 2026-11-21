export interface CategoryEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly color: string | null;
  readonly icon: string | null;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CategorySortField = "name" | "isActive" | "createdAt" | "updatedAt" | "id";

export interface CategoryListFilter {
  readonly organizationId: string;
  readonly isActive?: boolean | undefined;
  readonly search?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: CategorySortField;
  readonly sortDirection: "asc" | "desc";
}

export interface AuthorizedCategoryQueryScope {
  readonly hasGlobalDeny: boolean;
  readonly hasGlobalAllow: boolean;
  readonly allowedCategoryIds: readonly string[];
  readonly deniedCategoryIds: readonly string[];
}
