export const FOLDER_STATUSES = ["ACTIVE", "ARCHIVED"] as const;

export type FolderStatus = (typeof FOLDER_STATUSES)[number];

export interface FolderEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly materializedPath: string;
  readonly status: FolderStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type FolderSortField = "name" | "status" | "createdAt" | "updatedAt" | "id";

export interface FolderListFilter {
  readonly organizationId: string;
  readonly parentId?: string | null | undefined;
  readonly status?: FolderStatus | undefined;
  readonly search?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: FolderSortField;
  readonly sortDirection: "asc" | "desc";
}

export interface AuthorizedFolderQueryScope {
  readonly hasGlobalDeny: boolean;
  readonly hasGlobalAllow: boolean;
  readonly allowedFolderIds: readonly string[];
  readonly deniedFolderIds: readonly string[];
}
