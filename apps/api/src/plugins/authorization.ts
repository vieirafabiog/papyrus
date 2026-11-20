import {
  type AuthorizationSubjectContext,
  evaluateAuthorization,
  evaluateDocumentAuthorization,
  type PermissionPair,
  roleGrantsPermission,
  type RolePermissionsLookup,
  SYSTEM_ROLE_DEFINITIONS,
  type SystemRoleKey,
} from "@docuflow/auth";
import type { AuthMeResponse } from "@docuflow/contracts";
import type {
  AuthorizationRepository,
  AuthorizedDocumentQueryScope,
  LoadedAuthorizationSubject,
} from "@docuflow/database";
import type {
  AccessAction,
  AccessScope,
  DocumentEntity,
  DocumentRepositoryPort,
} from "@docuflow/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME } from "../modules/auth/auth.routes.js";
import type { AuthService } from "../modules/auth/auth.service.js";

function isSystemRoleKey(key: string): key is SystemRoleKey {
  return key in SYSTEM_ROLE_DEFINITIONS;
}

export function buildRolePermissionsLookup(
  loaded: LoadedAuthorizationSubject,
): RolePermissionsLookup {
  const map = new Map<string, PermissionPair[]>();

  for (const perm of loaded.rolePermissions) {
    const existing = map.get(perm.roleId) ?? [];
    existing.push({ action: perm.action, resource: perm.resource });
    map.set(perm.roleId, existing);
  }

  for (const assignment of loaded.assignments) {
    if (!map.has(assignment.roleId) && isSystemRoleKey(assignment.roleKey)) {
      map.set(assignment.roleId, [...SYSTEM_ROLE_DEFINITIONS[assignment.roleKey].permissions]);
    }
  }

  return map;
}

export function toSubjectContext(loaded: LoadedAuthorizationSubject): AuthorizationSubjectContext {
  return {
    userId: loaded.userId,
    organizationId: loaded.organizationId,
    assignments: loaded.assignments.map((item) => ({
      roleId: item.roleId,
      scope: item.scope,
      effect: item.effect,
      source: item.source,
    })),
  };
}

export function buildDocumentQueryScope(
  loaded: LoadedAuthorizationSubject,
  rolePermissions: RolePermissionsLookup,
  action: AccessAction,
): AuthorizedDocumentQueryScope {
  let hasGlobalDeny = false;
  let hasGlobalAllow = false;
  const allowedCategories = new Set<string>();
  const allowedFolders = new Set<string>();
  const allowedDocuments = new Set<string>();
  const deniedCategories = new Set<string>();
  const deniedFolders = new Set<string>();
  const deniedDocuments = new Set<string>();

  for (const assignment of loaded.assignments) {
    const perms = rolePermissions.get(assignment.roleId);
    if (!perms || !roleGrantsPermission(perms, action, "DOCUMENT")) {
      continue;
    }

    const isDeny = assignment.effect === "DENY";
    switch (assignment.scope.type) {
      case "GLOBAL":
        if (isDeny) {
          hasGlobalDeny = true;
        } else {
          hasGlobalAllow = true;
        }
        break;
      case "CATEGORY":
        if (isDeny) {
          deniedCategories.add(assignment.scope.categoryId);
        } else {
          allowedCategories.add(assignment.scope.categoryId);
        }
        break;
      case "FOLDER":
        if (isDeny) {
          deniedFolders.add(assignment.scope.folderId);
        } else {
          allowedFolders.add(assignment.scope.folderId);
        }
        break;
      case "DOCUMENT":
        if (isDeny) {
          deniedDocuments.add(assignment.scope.documentId);
        } else {
          allowedDocuments.add(assignment.scope.documentId);
        }
        break;
    }
  }

  return {
    hasGlobalDeny,
    hasGlobalAllow,
    allowedCategoryIds: Array.from(allowedCategories),
    allowedFolderIds: Array.from(allowedFolders),
    allowedDocumentIds: Array.from(allowedDocuments),
    deniedCategoryIds: Array.from(deniedCategories),
    deniedFolderIds: Array.from(deniedFolders),
    deniedDocumentIds: Array.from(deniedDocuments),
  };
}

export interface AuthenticatedAuthorizationContext {
  readonly me: AuthMeResponse;
  readonly loaded: LoadedAuthorizationSubject;
  readonly subject: AuthorizationSubjectContext;
  readonly rolePermissions: RolePermissionsLookup;
}

export interface DocumentAuthorizationGuard {
  requireSubject(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedAuthorizationContext | null>;
  authorizeCreateScope(
    ctx: AuthenticatedAuthorizationContext,
    categoryId: string,
    folderId: string | null,
    reply: FastifyReply,
    requestId: string,
  ): Promise<boolean>;
  authorizeDocument(
    ctx: AuthenticatedAuthorizationContext,
    documentId: string,
    action: AccessAction,
    reply: FastifyReply,
    requestId: string,
  ): Promise<DocumentEntity | null>;
}

export function createDocumentAuthorizationGuard(deps: {
  readonly authService: AuthService;
  readonly authzRepository: AuthorizationRepository;
  readonly documentRepository: DocumentRepositoryPort;
}): DocumentAuthorizationGuard {
  return {
    async requireSubject(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<AuthenticatedAuthorizationContext | null> {
      const rawToken = request.cookies[SESSION_COOKIE_NAME];
      const outcome = await deps.authService.getMe(rawToken);
      if (!outcome) {
        void reply.status(401).send({
          error: {
            code: "UNAUTHORIZED",
            message: "Sessão não autenticada ou expirada.",
            requestId: request.id,
          },
        });
        return null;
      }

      const loaded = await deps.authzRepository.loadSubject(
        outcome.me.user.organizationId,
        outcome.me.user.id,
      );
      return {
        me: outcome.me,
        loaded,
        subject: toSubjectContext(loaded),
        rolePermissions: buildRolePermissionsLookup(loaded),
      };
    },

    async authorizeCreateScope(
      ctx: AuthenticatedAuthorizationContext,
      categoryId: string,
      folderId: string | null,
      reply: FastifyReply,
      requestId: string,
    ): Promise<boolean> {
      const folderAncestors = await deps.authzRepository.loadFolderAncestorIds(
        ctx.me.user.organizationId,
        folderId,
      );

      const candidateScopes: AccessScope[] = [
        { type: "GLOBAL" },
        { type: "CATEGORY", categoryId },
        ...folderAncestors.map((id) => ({ type: "FOLDER" as const, folderId: id })),
      ];

      let hasAllow = false;
      for (const assignment of ctx.subject.assignments) {
        const perms = ctx.rolePermissions.get(assignment.roleId);
        if (!perms || !roleGrantsPermission(perms, "CREATE", "DOCUMENT")) {
          continue;
        }
        const applies = candidateScopes.some((target) => {
          if (assignment.scope.type === "GLOBAL") {
            return true;
          }
          if (assignment.scope.type === "CATEGORY" && target.type === "CATEGORY") {
            return assignment.scope.categoryId === target.categoryId;
          }
          if (assignment.scope.type === "FOLDER" && target.type === "FOLDER") {
            return assignment.scope.folderId === target.folderId;
          }
          return false;
        });
        if (!applies) {
          continue;
        }
        if (assignment.effect === "DENY") {
          hasAllow = false;
          break;
        }
        hasAllow = true;
      }

      if (!hasAllow) {
        void reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para criar documentos neste escopo.",
            requestId,
          },
        });
        return false;
      }
      return true;
    },

    async authorizeDocument(
      ctx: AuthenticatedAuthorizationContext,
      documentId: string,
      action: AccessAction,
      reply: FastifyReply,
      requestId: string,
    ): Promise<DocumentEntity | null> {
      const doc = await deps.documentRepository.findById(documentId);
      if (!doc || doc.organizationId !== ctx.me.user.organizationId) {
        const globalDecision = evaluateAuthorization(
          ctx.subject,
          { action, resource: "DOCUMENT", scope: { type: "GLOBAL" } },
          ctx.rolePermissions,
        );
        if (!globalDecision.allowed) {
          void reply.status(403).send({
            error: {
              code: "FORBIDDEN",
              message: "Você não possui permissão para acessar este documento.",
              requestId,
            },
          });
          return null;
        }
        void reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Documento não encontrado.",
            requestId,
          },
        });
        return null;
      }

      const folderAncestorIds = await deps.authzRepository.loadFolderAncestorIds(
        ctx.me.user.organizationId,
        doc.folderId,
      );
      const decision = evaluateDocumentAuthorization(
        ctx.subject,
        action,
        {
          documentId: doc.id,
          categoryId: doc.categoryId,
          folderAncestorIds,
        },
        ctx.rolePermissions,
      );

      if (!decision.allowed) {
        void reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para acessar este documento.",
            requestId,
          },
        });
        return null;
      }

      return doc;
    },
  };
}
