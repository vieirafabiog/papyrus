export const AUTH_MODULE_VERSION = 1 as const;

export {
  type AuthorizationSubjectContext,
  buildSystemRolePermissionMap,
  doesScopeMatch,
  evaluateAuthorization,
  type PrincipalAssignment,
  type RolePermissionsLookup,
} from "./authorization/authorizer.js";

export {
  type CategoryScopeContext,
  type DocumentScopeContext,
  evaluateCategoryAuthorization,
  evaluateDocumentAuthorization,
  evaluateFolderAuthorization,
  type FolderScopeContext,
  resolveApplicableScopesForCategory,
  resolveApplicableScopesForDocument,
  resolveApplicableScopesForFolder,
} from "./authorization/scope-resolver.js";

export {
  PERMISSION_CATALOG,
  type PermissionPair,
  roleGrantsPermission,
  SYSTEM_ROLE_DEFINITIONS,
  type SystemRoleDefinition,
  type SystemRoleKey,
} from "./authorization/role-catalog.js";

export {
  createPasswordService,
  type PasswordService,
  type PasswordServiceOptions,
} from "./password-service.js";

export {
  createSessionService,
  hashSessionToken,
  type SessionService,
  type SessionServiceOptions,
} from "./session-service.js";

export type {
  CreateSessionInput,
  CreateSessionRecordInput,
  IssuedSession,
  SessionPolicy,
  SessionStorePort,
  StoredSessionRecord,
  ValidatedSession,
} from "./session.types.js";
