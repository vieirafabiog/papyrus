import type {
  AccessAction,
  AccessResource,
  AccessScope,
  AuthorizationDecision,
} from "@docuflow/domain";
import {
  type AuthorizationSubjectContext,
  doesScopeMatch,
  type RolePermissionsLookup,
} from "./authorizer.js";
import { roleGrantsPermission } from "./role-catalog.js";

export interface DocumentScopeContext {
  readonly documentId: string;
  readonly categoryId: string;
  readonly folderAncestorIds: readonly string[];
}

export interface FolderScopeContext {
  readonly folderId: string;
  readonly ancestorFolderIds: readonly string[];
}

export function resolveApplicableScopesForDocument(
  context: DocumentScopeContext,
): readonly AccessScope[] {
  const scopes: AccessScope[] = [
    { type: "GLOBAL" },
    { type: "CATEGORY", categoryId: context.categoryId },
    { type: "DOCUMENT", documentId: context.documentId },
  ];

  const seenFolders = new Set<string>();
  for (const folderId of context.folderAncestorIds) {
    if (!seenFolders.has(folderId)) {
      seenFolders.add(folderId);
      scopes.push({ type: "FOLDER", folderId });
    }
  }

  return scopes;
}

export function resolveApplicableScopesForFolder(
  context: FolderScopeContext,
): readonly AccessScope[] {
  const scopes: AccessScope[] = [
    { type: "GLOBAL" },
    { type: "FOLDER", folderId: context.folderId },
  ];

  const seenFolders = new Set<string>([context.folderId]);
  for (const ancestorId of context.ancestorFolderIds) {
    if (!seenFolders.has(ancestorId)) {
      seenFolders.add(ancestorId);
      scopes.push({ type: "FOLDER", folderId: ancestorId });
    }
  }

  return scopes;
}

function evaluateWithApplicableScopes(
  subject: AuthorizationSubjectContext,
  action: AccessAction,
  resource: AccessResource,
  applicableScopes: readonly AccessScope[],
  rolePermissions: RolePermissionsLookup,
): AuthorizationDecision {
  let hasAllow = false;

  for (const assignment of subject.assignments) {
    const permissions = rolePermissions.get(assignment.roleId);
    if (!permissions || !roleGrantsPermission(permissions, action, resource)) {
      continue;
    }

    const matchesContext = applicableScopes.some((targetScope) =>
      doesScopeMatch(assignment.scope, targetScope),
    );
    if (!matchesContext) {
      continue;
    }

    if (assignment.effect === "DENY") {
      return {
        allowed: false,
        effect: "DENY",
        reason: "Negação explícita aplicada ao escopo ou herança do recurso.",
      };
    }

    hasAllow = true;
  }

  if (hasAllow) {
    return {
      allowed: true,
      effect: "ALLOW",
      reason: "Acesso concedido no escopo direto ou herdado.",
    };
  }

  return {
    allowed: false,
    effect: "DENY",
    reason: "Nenhuma permissão aplicável encontrada no escopo (negado por padrão).",
  };
}

export function evaluateDocumentAuthorization(
  subject: AuthorizationSubjectContext,
  action: AccessAction,
  context: DocumentScopeContext,
  rolePermissions: RolePermissionsLookup,
): AuthorizationDecision {
  const applicableScopes = resolveApplicableScopesForDocument(context);
  return evaluateWithApplicableScopes(
    subject,
    action,
    "DOCUMENT",
    applicableScopes,
    rolePermissions,
  );
}

export function evaluateFolderAuthorization(
  subject: AuthorizationSubjectContext,
  action: AccessAction,
  context: FolderScopeContext,
  rolePermissions: RolePermissionsLookup,
): AuthorizationDecision {
  const applicableScopes = resolveApplicableScopesForFolder(context);
  return evaluateWithApplicableScopes(
    subject,
    action,
    "FOLDER",
    applicableScopes,
    rolePermissions,
  );
}
