export interface TagEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly color: string | null;
  readonly createdAt: string;
}

export type TagSortField = "name" | "createdAt" | "id";

export interface TagListFilter {
  readonly organizationId: string;
  readonly search?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: TagSortField;
  readonly sortDirection: "asc" | "desc";
}
