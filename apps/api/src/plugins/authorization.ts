import {
  type AuthorizationSubjectContext,
  type PermissionPair,
  type RolePermissionsLookup,
  SYSTEM_ROLE_DEFINITIONS,
  type SystemRoleKey,
  evaluateAuthorization,
  evaluateCategoryAuthorization,
  evaluateDocumentAuthorization,
  evaluateFolderAuthorization,
  roleGrantsPermission,
} from "@papyrus/auth";
import type { AuthMeResponse } from "@papyrus/contracts";
import type {
  AuthorizationRepository,
  AuthorizedDocumentQueryScope,
  LoadedAuthorizationSubject,
} from "@papyrus/database";
import {
  type AccessAction,
  type AccessScope,
  type AuditRepositoryPort,
  type AuditWriter,
  type AuthorizedCategoryQueryScope,
  type AuthorizedFolderQueryScope,
  type CategoryEntity,
  type CategoryRepositoryPort,
  type DocumentEntity,
  type DocumentRepositoryPort,
  type FolderEntity,
  type FolderRepositoryPort,
  createAuditWriter,
} from "@papyrus/domain";
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

export function buildFolderQueryScope(
  loaded: LoadedAuthorizationSubject,
  rolePermissions: RolePermissionsLookup,
  action: AccessAction,
): AuthorizedFolderQueryScope {
  let hasGlobalDeny = false;
  let hasGlobalAllow = false;
  const allowedFolders = new Set<string>();
  const deniedFolders = new Set<string>();

  for (const assignment of loaded.assignments) {
    const perms = rolePermissions.get(assignment.roleId);
    if (!perms || !roleGrantsPermission(perms, action, "FOLDER")) {
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
      case "FOLDER":
        if (isDeny) {
          deniedFolders.add(assignment.scope.folderId);
        } else {
          allowedFolders.add(assignment.scope.folderId);
        }
        break;
      case "CATEGORY":
      case "DOCUMENT":
        break;
    }
  }

  return {
    hasGlobalDeny,
    hasGlobalAllow,
    allowedFolderIds: Array.from(allowedFolders),
    deniedFolderIds: Array.from(deniedFolders),
  };
}

export function buildCategoryQueryScope(
  loaded: LoadedAuthorizationSubject,
  rolePermissions: RolePermissionsLookup,
  action: AccessAction,
): AuthorizedCategoryQueryScope {
  let hasGlobalDeny = false;
  let hasGlobalAllow = false;
  const allowedCategories = new Set<string>();
  const deniedCategories = new Set<string>();

  for (const assignment of loaded.assignments) {
    const perms = rolePermissions.get(assignment.roleId);
    if (!perms || !roleGrantsPermission(perms, action, "CATEGORY")) {
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
      case "DOCUMENT":
        break;
    }
  }

  return {
    hasGlobalDeny,
    hasGlobalAllow,
    allowedCategoryIds: Array.from(allowedCategories),
    deniedCategoryIds: Array.from(deniedCategories),
  };
}

async function resolveAuthenticatedSubject(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  authzRepository: AuthorizationRepository,
): Promise<AuthenticatedAuthorizationContext | null> {
  const rawToken = request.cookies[SESSION_COOKIE_NAME];
  const outcome = await authService.getMe(rawToken);
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

  const loaded = await authzRepository.loadSubject(
    outcome.me.user.organizationId,
    outcome.me.user.id,
  );
  return {
    me: outcome.me,
    loaded,
    subject: toSubjectContext(loaded),
    rolePermissions: buildRolePermissionsLookup(loaded),
  };
}

export interface AuthenticatedAuthorizationContext {
  readonly me: AuthMeResponse;
  readonly loaded: LoadedAuthorizationSubject;
  readonly subject: AuthorizationSubjectContext;
  readonly rolePermissions: RolePermissionsLookup;
}

async function recordAuthorizationDenied(
  auditWriter: AuditWriter | null,
  input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly ipAddress?: string | undefined;
    readonly resourceType: "DOCUMENT" | "FOLDER" | "CATEGORY";
    readonly resourceId: string | null;
    readonly requiredAction: AccessAction;
    readonly reason: string;
  },
): Promise<void> {
  if (!auditWriter) {
    return;
  }
  await auditWriter.write({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: "AUTHORIZATION_DENIED",
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    result: "DENIED",
    requestId: input.requestId,
    ipAddress: input.ipAddress ?? null,
    metadata: {
      requiredAction: input.requiredAction,
      reason: input.reason,
    },
  });
}

export type DocumentAccessCheckResult =
  | { readonly allowed: true; readonly document: DocumentEntity }
  | {
      readonly allowed: false;
      readonly statusCode: 403 | 404;
      readonly code: "FORBIDDEN" | "NOT_FOUND";
      readonly message: string;
    };

export interface DocumentAuthorizationGuard {
  requireSubject(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedAuthorizationContext | null>;
  inspectCreateScope(
    ctx: AuthenticatedAuthorizationContext,
    categoryId: string,
    folderId: string | null,
    requestId: string,
    ipAddress?: string | undefined,
  ): Promise<boolean>;
  authorizeCreateScope(
    ctx: AuthenticatedAuthorizationContext,
    categoryId: string,
    folderId: string | null,
    reply: FastifyReply,
    requestId: string,
    ipAddress?: string | undefined,
  ): Promise<boolean>;
  authorizeUploadScope(
    ctx: AuthenticatedAuthorizationContext,
    categoryId: string | null,
    folderId: string | null,
    reply: FastifyReply,
    requestId: string,
    ipAddress?: string | undefined,
  ): Promise<boolean>;
  inspectDocument(
    ctx: AuthenticatedAuthorizationContext,
    documentId: string,
    action: AccessAction,
    requestId: string,
    ipAddress?: string | undefined,
  ): Promise<DocumentAccessCheckResult>;
  authorizeDocument(
    ctx: AuthenticatedAuthorizationContext,
    documentId: string,
    action: AccessAction,
    reply: FastifyReply,
    requestId: string,
    ipAddress?: string | undefined,
  ): Promise<DocumentEntity | null>;
}

export function createDocumentAuthorizationGuard(deps: {
  readonly authService: AuthService;
  readonly authzRepository: AuthorizationRepository;
  readonly documentRepository: DocumentRepositoryPort;
  readonly auditRepository?: AuditRepositoryPort | undefined;
}): DocumentAuthorizationGuard {
  const auditWriter = deps.auditRepository
    ? createAuditWriter({ repository: deps.auditRepository })
    : null;

  const inspectScopeAction = async (
    ctx: AuthenticatedAuthorizationContext,
    action: AccessAction,
    categoryId: string | null,
    folderId: string | null,
    requestId: string,
    ipAddress?: string | undefined,
  ): Promise<boolean> => {
    const folderAncestors = await deps.authzRepository.loadFolderAncestorIds(
      ctx.me.user.organizationId,
      folderId,
    );

    const candidateScopes: AccessScope[] = [{ type: "GLOBAL" }];
    if (categoryId) {
      candidateScopes.push({ type: "CATEGORY", categoryId });
    }
    for (const id of folderAncestors) {
      candidateScopes.push({ type: "FOLDER", folderId: id });
    }

    let hasAllow = false;
    for (const assignment of ctx.subject.assignments) {
      const perms = ctx.rolePermissions.get(assignment.roleId);
      if (!perms || !roleGrantsPermission(perms, action, "DOCUMENT")) {
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
      await recordAuthorizationDenied(auditWriter, {
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        requestId,
        ipAddress,
        resourceType: "DOCUMENT",
        resourceId: null,
        requiredAction: action,
        reason: "SCOPE_CREATE_OR_UPLOAD_DENIED",
      });
      return false;
    }
    return true;
  };

  const authorizeScopeAction = async (
    ctx: AuthenticatedAuthorizationContext,
    action: AccessAction,
    categoryId: string | null,
    folderId: string | null,
    reply: FastifyReply,
    requestId: string,
    ipAddress?: string | undefined,
  ): Promise<boolean> => {
    const allowed = await inspectScopeAction(
      ctx,
      action,
      categoryId,
      folderId,
      requestId,
      ipAddress,
    );
    if (!allowed) {
      void reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message:
            action === "UPLOAD"
              ? "Você não possui permissão para iniciar upload neste escopo."
              : "Você não possui permissão para criar documentos neste escopo.",
          requestId,
        },
      });
      return false;
    }
    return true;
  };

  const inspectDocument = async (
    ctx: AuthenticatedAuthorizationContext,
    documentId: string,
    action: AccessAction,
    requestId: string,
    ipAddress?: string | undefined,
  ): Promise<DocumentAccessCheckResult> => {
    const doc = await deps.documentRepository.findById(documentId);
    if (!doc || doc.organizationId !== ctx.me.user.organizationId) {
      const globalDecision = evaluateAuthorization(
        ctx.subject,
        { action, resource: "DOCUMENT", scope: { type: "GLOBAL" } },
        ctx.rolePermissions,
      );
      if (!globalDecision.allowed) {
        await recordAuthorizationDenied(auditWriter, {
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId,
          ipAddress,
          resourceType: "DOCUMENT",
          resourceId: null,
          requiredAction: action,
          reason: "MISSING_OR_DENIED_SCOPE",
        });
        return {
          allowed: false,
          statusCode: 403,
          code: "FORBIDDEN",
          message: "Você não possui permissão para acessar este documento.",
        };
      }
      return {
        allowed: false,
        statusCode: 404,
        code: "NOT_FOUND",
        message: "Documento não encontrado.",
      };
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
      await recordAuthorizationDenied(auditWriter, {
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        requestId,
        ipAddress,
        resourceType: "DOCUMENT",
        resourceId: doc.id,
        requiredAction: action,
        reason: decision.reason,
      });
      return {
        allowed: false,
        statusCode: 403,
        code: "FORBIDDEN",
        message: "Você não possui permissão para acessar este documento.",
      };
    }

    return { allowed: true, document: doc };
  };

  return {
    requireSubject(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<AuthenticatedAuthorizationContext | null> {
      return resolveAuthenticatedSubject(request, reply, deps.authService, deps.authzRepository);
    },

    async inspectCreateScope(
      ctx: AuthenticatedAuthorizationContext,
      categoryId: string,
      folderId: string | null,
      requestId: string,
      ipAddress?: string | undefined,
    ): Promise<boolean> {
      return inspectScopeAction(ctx, "CREATE", categoryId, folderId, requestId, ipAddress);
    },

    async authorizeCreateScope(
      ctx: AuthenticatedAuthorizationContext,
      categoryId: string,
      folderId: string | null,
      reply: FastifyReply,
      requestId: string,
      ipAddress?: string | undefined,
    ): Promise<boolean> {
      return authorizeScopeAction(ctx, "CREATE", categoryId, folderId, reply, requestId, ipAddress);
    },

    async authorizeUploadScope(
      ctx: AuthenticatedAuthorizationContext,
      categoryId: string | null,
      folderId: string | null,
      reply: FastifyReply,
      requestId: string,
      ipAddress?: string | undefined,
    ): Promise<boolean> {
      return authorizeScopeAction(ctx, "UPLOAD", categoryId, folderId, reply, requestId, ipAddress);
    },

    inspectDocument,

    async authorizeDocument(
      ctx: AuthenticatedAuthorizationContext,
      documentId: string,
      action: AccessAction,
      reply: FastifyReply,
      requestId: string,
      ipAddress?: string | undefined,
    ): Promise<DocumentEntity | null> {
      const outcome = await inspectDocument(ctx, documentId, action, requestId, ipAddress);
      if (!outcome.allowed) {
        void reply.status(outcome.statusCode).send({
          error: {
            code: outcome.code,
            message: outcome.message,
            requestId,
          },
        });
        return null;
      }
      return outcome.document;
    },
  };
}

export interface FolderAuthorizationGuard {
  requireSubject(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedAuthorizationContext | null>;
  authorizeCreateScope(
    request: FastifyRequest,
    reply: FastifyReply,
    parentId: string | null,
  ): Promise<AuthenticatedAuthorizationContext | null>;
  authorizeDestinationScope(
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: AuthenticatedAuthorizationContext,
    targetParentId: string | null,
  ): Promise<boolean>;
  authorizeFolder(
    request: FastifyRequest,
    reply: FastifyReply,
    action: AccessAction,
    folderId: string,
  ): Promise<{
    readonly subject: AuthenticatedAuthorizationContext;
    readonly folder: FolderEntity;
  } | null>;
}

/**
 * Creates the server-side authorization guard for hierarchical folder routes.
 */
export function createFolderAuthorizationGuard(deps: {
  readonly authService: AuthService;
  readonly authzRepository: AuthorizationRepository;
  readonly folderRepository: FolderRepositoryPort;
  readonly auditRepository?: AuditRepositoryPort | undefined;
}): FolderAuthorizationGuard {
  const auditWriter = deps.auditRepository
    ? createAuditWriter({ repository: deps.auditRepository })
    : null;

  const verifyParentScopeForCreate = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: AuthenticatedAuthorizationContext,
    parentId: string | null,
  ): Promise<boolean> => {
    if (parentId === null) {
      const decision = evaluateAuthorization(
        ctx.subject,
        { action: "CREATE", resource: "FOLDER", scope: { type: "GLOBAL" } },
        ctx.rolePermissions,
      );
      if (!decision.allowed) {
        await recordAuthorizationDenied(auditWriter, {
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          ipAddress: request.ip,
          resourceType: "FOLDER",
          resourceId: null,
          requiredAction: "CREATE",
          reason: decision.reason,
        });
        void reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para criar ou mover pastas na raiz.",
            requestId: request.id,
          },
        });
        return false;
      }
      return true;
    }

    const parent = await deps.folderRepository.findById(parentId);
    if (!parent || parent.organizationId !== ctx.me.user.organizationId) {
      const globalDecision = evaluateAuthorization(
        ctx.subject,
        { action: "CREATE", resource: "FOLDER", scope: { type: "GLOBAL" } },
        ctx.rolePermissions,
      );
      if (!globalDecision.allowed) {
        await recordAuthorizationDenied(auditWriter, {
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          ipAddress: request.ip,
          resourceType: "FOLDER",
          resourceId: null,
          requiredAction: "CREATE",
          reason: "MISSING_OR_DENIED_SCOPE",
        });
        void reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para criar ou mover pastas neste escopo.",
            requestId: request.id,
          },
        });
        return false;
      }
      return true;
    }

    const ancestorFolderIds = await deps.authzRepository.loadFolderAncestorIds(
      ctx.me.user.organizationId,
      parent.id,
    );
    const decision = evaluateFolderAuthorization(
      ctx.subject,
      "CREATE",
      { folderId: parent.id, ancestorFolderIds },
      ctx.rolePermissions,
    );
    if (!decision.allowed) {
      await recordAuthorizationDenied(auditWriter, {
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        requestId: request.id,
        ipAddress: request.ip,
        resourceType: "FOLDER",
        resourceId: parent.id,
        requiredAction: "CREATE",
        reason: decision.reason,
      });
      void reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Você não possui permissão para criar ou mover pastas neste escopo.",
          requestId: request.id,
        },
      });
      return false;
    }

    return true;
  };

  return {
    requireSubject(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<AuthenticatedAuthorizationContext | null> {
      return resolveAuthenticatedSubject(request, reply, deps.authService, deps.authzRepository);
    },

    async authorizeCreateScope(
      request: FastifyRequest,
      reply: FastifyReply,
      parentId: string | null,
    ): Promise<AuthenticatedAuthorizationContext | null> {
      const ctx = await resolveAuthenticatedSubject(
        request,
        reply,
        deps.authService,
        deps.authzRepository,
      );
      if (!ctx) {
        return null;
      }

      const allowed = await verifyParentScopeForCreate(request, reply, ctx, parentId);
      return allowed ? ctx : null;
    },

    authorizeDestinationScope(
      request: FastifyRequest,
      reply: FastifyReply,
      ctx: AuthenticatedAuthorizationContext,
      targetParentId: string | null,
    ): Promise<boolean> {
      return verifyParentScopeForCreate(request, reply, ctx, targetParentId);
    },

    async authorizeFolder(
      request: FastifyRequest,
      reply: FastifyReply,
      action: AccessAction,
      folderId: string,
    ): Promise<{
      readonly subject: AuthenticatedAuthorizationContext;
      readonly folder: FolderEntity;
    } | null> {
      const ctx = await resolveAuthenticatedSubject(
        request,
        reply,
        deps.authService,
        deps.authzRepository,
      );
      if (!ctx) {
        return null;
      }

      const folder = await deps.folderRepository.findById(folderId);
      if (!folder || folder.organizationId !== ctx.me.user.organizationId) {
        const globalDecision = evaluateAuthorization(
          ctx.subject,
          { action, resource: "FOLDER", scope: { type: "GLOBAL" } },
          ctx.rolePermissions,
        );
        if (!globalDecision.allowed) {
          await recordAuthorizationDenied(auditWriter, {
            organizationId: ctx.me.user.organizationId,
            actorUserId: ctx.me.user.id,
            requestId: request.id,
            ipAddress: request.ip,
            resourceType: "FOLDER",
            resourceId: null,
            requiredAction: action,
            reason: "MISSING_OR_DENIED_SCOPE",
          });
          void reply.status(403).send({
            error: {
              code: "FORBIDDEN",
              message: "Você não possui permissão para acessar esta pasta.",
              requestId: request.id,
            },
          });
          return null;
        }
        void reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Pasta não encontrada.",
            requestId: request.id,
          },
        });
        return null;
      }

      const ancestorFolderIds = await deps.authzRepository.loadFolderAncestorIds(
        ctx.me.user.organizationId,
        folder.id,
      );
      const decision = evaluateFolderAuthorization(
        ctx.subject,
        action,
        { folderId: folder.id, ancestorFolderIds },
        ctx.rolePermissions,
      );
      if (!decision.allowed) {
        await recordAuthorizationDenied(auditWriter, {
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          ipAddress: request.ip,
          resourceType: "FOLDER",
          resourceId: folder.id,
          requiredAction: action,
          reason: decision.reason,
        });
        void reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para executar esta operação nesta pasta.",
            requestId: request.id,
          },
        });
        return null;
      }

      return { subject: ctx, folder };
    },
  };
}

export interface CategoryAuthorizationGuard {
  requireSubject(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedAuthorizationContext | null>;
  authorizeCreateScope(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedAuthorizationContext | null>;
  authorizeCategory(
    request: FastifyRequest,
    reply: FastifyReply,
    action: AccessAction,
    categoryId: string,
  ): Promise<{
    readonly subject: AuthenticatedAuthorizationContext;
    readonly category: CategoryEntity;
  } | null>;
}

/**
 * Creates the server-side authorization guard for category routes.
 */
export function createCategoryAuthorizationGuard(deps: {
  readonly authService: AuthService;
  readonly authzRepository: AuthorizationRepository;
  readonly categoryRepository: CategoryRepositoryPort;
  readonly auditRepository?: AuditRepositoryPort | undefined;
}): CategoryAuthorizationGuard {
  const auditWriter = deps.auditRepository
    ? createAuditWriter({ repository: deps.auditRepository })
    : null;

  return {
    requireSubject(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<AuthenticatedAuthorizationContext | null> {
      return resolveAuthenticatedSubject(request, reply, deps.authService, deps.authzRepository);
    },

    async authorizeCreateScope(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<AuthenticatedAuthorizationContext | null> {
      const ctx = await resolveAuthenticatedSubject(
        request,
        reply,
        deps.authService,
        deps.authzRepository,
      );
      if (!ctx) {
        return null;
      }

      const decision = evaluateAuthorization(
        ctx.subject,
        { action: "CREATE", resource: "CATEGORY", scope: { type: "GLOBAL" } },
        ctx.rolePermissions,
      );
      if (!decision.allowed) {
        await recordAuthorizationDenied(auditWriter, {
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          ipAddress: request.ip,
          resourceType: "CATEGORY",
          resourceId: null,
          requiredAction: "CREATE",
          reason: decision.reason,
        });
        void reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para criar categorias.",
            requestId: request.id,
          },
        });
        return null;
      }

      return ctx;
    },

    async authorizeCategory(
      request: FastifyRequest,
      reply: FastifyReply,
      action: AccessAction,
      categoryId: string,
    ): Promise<{
      readonly subject: AuthenticatedAuthorizationContext;
      readonly category: CategoryEntity;
    } | null> {
      const ctx = await resolveAuthenticatedSubject(
        request,
        reply,
        deps.authService,
        deps.authzRepository,
      );
      if (!ctx) {
        return null;
      }

      const category = await deps.categoryRepository.findById(categoryId);
      if (!category || category.organizationId !== ctx.me.user.organizationId) {
        const globalDecision = evaluateAuthorization(
          ctx.subject,
          { action, resource: "CATEGORY", scope: { type: "GLOBAL" } },
          ctx.rolePermissions,
        );
        if (!globalDecision.allowed) {
          await recordAuthorizationDenied(auditWriter, {
            organizationId: ctx.me.user.organizationId,
            actorUserId: ctx.me.user.id,
            requestId: request.id,
            ipAddress: request.ip,
            resourceType: "CATEGORY",
            resourceId: null,
            requiredAction: action,
            reason: "MISSING_OR_DENIED_SCOPE",
          });
          void reply.status(403).send({
            error: {
              code: "FORBIDDEN",
              message: "Você não possui permissão para acessar esta categoria.",
              requestId: request.id,
            },
          });
          return null;
        }
        void reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Categoria não encontrada.",
            requestId: request.id,
          },
        });
        return null;
      }

      const decision = evaluateCategoryAuthorization(
        ctx.subject,
        action,
        { categoryId: category.id },
        ctx.rolePermissions,
      );
      if (!decision.allowed) {
        await recordAuthorizationDenied(auditWriter, {
          organizationId: ctx.me.user.organizationId,
          actorUserId: ctx.me.user.id,
          requestId: request.id,
          ipAddress: request.ip,
          resourceType: "CATEGORY",
          resourceId: category.id,
          requiredAction: action,
          reason: decision.reason,
        });
        void reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para executar esta operação nesta categoria.",
            requestId: request.id,
          },
        });
        return null;
      }

      return { subject: ctx, category };
    },
  };
}
