import type { CategoryFieldType } from "./metadata-validation.js";

export const CATEGORY_TEXT_INDEXING_MODES = ["NEVER", "ALWAYS", "ASK"] as const;
export type CategoryTextIndexingMode = (typeof CATEGORY_TEXT_INDEXING_MODES)[number];

export interface CategoryEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly color: string | null;
  readonly icon: string | null;
  readonly isActive: boolean;
  readonly textIndexingMode: CategoryTextIndexingMode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CategoryFieldEntity {
  readonly id: string;
  readonly categoryId: string;
  readonly key: string;
  readonly label: string;
  readonly type: CategoryFieldType;
  readonly required: boolean;
  readonly options: readonly string[] | null;
  readonly sortOrder: number;
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
