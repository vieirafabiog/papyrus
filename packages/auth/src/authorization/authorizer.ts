import type {
  AccessEffect,
  AccessScope,
  AuthorizationDecision,
  AuthorizationRequest,
} from "@docuflow/domain";
import {
  type PermissionPair,
  roleGrantsPermission,
  SYSTEM_ROLE_DEFINITIONS,
} from "./role-catalog.js";

export interface PrincipalAssignment {
  readonly roleId: string;
  readonly scope: AccessScope;
  readonly effect: AccessEffect;
  readonly source: "USER" | "GROUP";
}

export interface AuthorizationSubjectContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly assignments: readonly PrincipalAssignment[];
}

export type RolePermissionsLookup = ReadonlyMap<string, readonly PermissionPair[]>;

export function buildSystemRolePermissionMap(): Map<string, readonly PermissionPair[]> {
  const map = new Map<string, readonly PermissionPair[]>();
  for (const def of Object.values(SYSTEM_ROLE_DEFINITIONS)) {
    map.set(def.key, def.permissions);
  }
  return map;
}

export function doesScopeMatch(assignmentScope: AccessScope, targetScope: AccessScope): boolean {
  if (assignmentScope.type === "GLOBAL") {
    return true;
  }
  if (assignmentScope.type !== targetScope.type) {
    return false;
  }
  switch (assignmentScope.type) {
    case "CATEGORY":
      return (
        targetScope.type === "CATEGORY" &&
        assignmentScope.categoryId === targetScope.categoryId
      );
    case "FOLDER":
      return targetScope.type === "FOLDER" && assignmentScope.folderId === targetScope.folderId;
    case "DOCUMENT":
      return (
        targetScope.type === "DOCUMENT" &&
        assignmentScope.documentId === targetScope.documentId
      );
  }
}

export function evaluateAuthorization(
  subject: AuthorizationSubjectContext,
  request: AuthorizationRequest,
  rolePermissions: RolePermissionsLookup,
): AuthorizationDecision {
  let hasAllow = false;

  for (const assignment of subject.assignments) {
    if (!doesScopeMatch(assignment.scope, request.scope)) {
      continue;
    }

    const permissions = rolePermissions.get(assignment.roleId);
    if (!permissions || !roleGrantsPermission(permissions, request.action, request.resource)) {
      continue;
    }

    if (assignment.effect === "DENY") {
      return {
        allowed: false,
        effect: "DENY",
        reason: "Acesso negado explicitamente para este escopo.",
      };
    }

    hasAllow = true;
  }

  if (hasAllow) {
    return {
      allowed: true,
      effect: "ALLOW",
      reason: "Permissão concedida pelo papel atribuído no escopo.",
    };
  }

  return {
    allowed: false,
    effect: "DENY",
    reason: "Nenhuma concessão explícita encontrada (negado por padrão).",
  };
}
