export const ACCESS_ACTIONS = [
  "READ",
  "CREATE",
  "UPDATE",
  "DELETE",
  "UPLOAD",
  "DOWNLOAD",
  "APPROVE",
  "REJECT",
  "MANAGE_PERMISSIONS",
  "MANAGE_STORAGE",
  "MANAGE_USERS",
  "VIEW_AUDIT",
] as const;

export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export const ACCESS_RESOURCES = [
  "DOCUMENT",
  "FOLDER",
  "CATEGORY",
  "WORKFLOW",
  "USER",
  "GROUP",
  "ROLE",
  "STORAGE",
  "AUDIT",
  "ORGANIZATION",
] as const;

export type AccessResource = (typeof ACCESS_RESOURCES)[number];

export const ACCESS_SCOPE_TYPES = ["GLOBAL", "CATEGORY", "FOLDER", "DOCUMENT"] as const;

export type AccessScopeType = (typeof ACCESS_SCOPE_TYPES)[number];

export const ACCESS_EFFECTS = ["ALLOW", "DENY"] as const;

export type AccessEffect = (typeof ACCESS_EFFECTS)[number];

export const USER_STATUSES = ["ACTIVE", "INACTIVE", "LOCKED"] as const;

export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: UserStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GroupEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoleEntity {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
}

export interface PermissionEntity {
  readonly id: string;
  readonly action: AccessAction;
  readonly resource: AccessResource;
}

export type AccessScope =
  | { readonly type: "GLOBAL" }
  | { readonly type: "CATEGORY"; readonly categoryId: string }
  | { readonly type: "FOLDER"; readonly folderId: string }
  | { readonly type: "DOCUMENT"; readonly documentId: string };

export interface RoleScopeAssignment {
  readonly id: string;
  readonly userId: string;
  readonly roleId: string;
  readonly scope: AccessScope;
  readonly effect: AccessEffect;
  readonly createdAt: string;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly expiresAt: string;
}

export interface AuthorizationSubject {
  readonly userId: string;
  readonly organizationId: string;
  readonly groupIds: readonly string[];
  readonly assignments: readonly RoleScopeAssignment[];
}

export interface AuthorizationRequest {
  readonly action: AccessAction;
  readonly resource: AccessResource;
  readonly scope: AccessScope;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly effect: AccessEffect;
  readonly reason: string;
}
