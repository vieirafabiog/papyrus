export class DomainError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export {
  ACCESS_ACTIONS,
  ACCESS_EFFECTS,
  ACCESS_RESOURCES,
  ACCESS_SCOPE_TYPES,
  type AccessAction,
  type AccessEffect,
  type AccessResource,
  type AccessScope,
  type AccessScopeType,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type AuthorizationSubject,
  type GroupEntity,
  type PermissionEntity,
  type RoleEntity,
  type RoleScopeAssignment,
  type SessionSummary,
  USER_STATUSES,
  type UserEntity,
  type UserStatus,
} from "./access/access.types.js";

export {
  type CategoryFieldDefinition,
  type CategoryFieldType,
  type MetadataValidationIssue,
  type MetadataValidationResult,
  validateDocumentMetadata,
} from "./categories/metadata-validation.js";

export {
  ALLOWED_DOCUMENT_TRANSITIONS,
  assertDocumentStatusTransition,
  canSubmitDocumentForReview,
  canTransitionDocumentStatus,
  isFileObjectDownloadable,
} from "./documents/document-state.js";

export {
  DOCUMENT_STATUSES,
  type DocumentEntity,
  type DocumentMetadataMap,
  type DocumentMetadataValue,
  type DocumentStatus,
  type DocumentVersionEntity,
  FILE_OBJECT_STATUSES,
  type FileObjectEntity,
  type FileObjectStatus,
} from "./documents/document.types.js";

export {
  assertApprovalMatchesVersion,
  type BuildNextVersionInput,
  buildNextDocumentVersion,
  getNextVersionNumber,
  resolveCurrentVersion,
  type RestoreHistoricalVersionInput,
  type RestoredVersionResult,
  restoreHistoricalVersion,
} from "./documents/versioning.js";

export type {
  AuditEventInput,
  AuditEventRecord,
  AuditListFilter,
  AuditMetadataValue,
  AuditRepositoryPort,
  AuditResult,
} from "./ports/audit-repository.port.js";

export type {
  CreateDocumentInput,
  CreateDocumentVersionInput,
  DocumentListFilter,
  DocumentRepositoryPort,
  DocumentSortField,
  DocumentVersionRepositoryPort,
  PaginatedResult,
  UpdateDocumentInput,
} from "./ports/document-repository.port.js";

export type {
  CreateStorageConnectionInput,
  StorageConnectionEntity,
  StorageConnectionKind,
  StorageConnectionRepositoryPort,
  StorageConnectionStatus,
  StorageRoutingRuleEntity,
  StorageRoutingRuleRepositoryPort,
  UpdateStorageConnectionInput,
  UpsertStorageRoutingRuleInput,
} from "./ports/storage-connection-repository.port.js";

export {
  type BindNewFileObjectInput,
  bindFileObjectToStorageTarget,
  type ClearCategoryRoutingRuleCommand,
  createStorageRouterService,
  type ResolvedStorageTarget,
  type ResolveReadTargetInput,
  type ResolveWriteTargetInput,
  type SetStorageRoutingRuleCommand,
  type StorageRouteSource,
  type StorageRouterDependencies,
  type StorageRouterService,
} from "./storage/storage-router.js";

export {
  type CreateStorageConnectionCommand,
  createStorageConnectionAdminService,
  type SecretEncryptorPort,
  type StorageConnectionAdminService,
  type StorageConnectionAdminServiceDependencies,
  type StorageConnectionHealthCheckResult,
  type StorageConnectionHealthOutput,
  type StorageConnectionHealthTesterPort,
  type StorageConnectionTargetCommand,
  type StorageConnectionView,
  type StorageNonSecretConfigMap,
  toStorageConnectionView,
  type UpdateStorageConnectionCommand,
} from "./storage/storage-connections.js";

export type {
  TransactionContext,
  TransactionManagerPort,
} from "./ports/transaction.port.js";

export type {
  AddGroupMemberInput,
  CreateGroupInput,
  GroupRepositoryPort,
} from "./ports/group-repository.port.js";

export {
  type CreatedUploadSessionRecords,
  type CreateUploadSessionWithFileObjectInput,
  UPLOAD_SESSION_STATUSES,
  type UploadSessionEntity,
  type UploadSessionRepositoryPort,
  type UploadSessionStatus,
} from "./ports/upload-session-repository.port.js";

export {
  type CreateUploadSessionCommand,
  type CreateUploadSessionResult,
  createUploadSessionService,
  type UploadSessionService,
  type UploadSessionServiceDependencies,
} from "./uploads/upload-sessions.js";

export type {
  CreateUserInput,
  UpdateUserInput,
  UserRepositoryPort,
} from "./ports/user-repository.port.js";

export {
  type CreateGroupCommand,
  createGroupAdministrationService,
  type GroupAdministrationService,
  type GroupAdministrationServiceDependencies,
  type GroupMemberCommand,
} from "./users/group-management.js";

export {
  type ChangeUserStatusCommand,
  createUserAdministrationService,
  type CreateUserCommand,
  type PasswordHasherPort,
  type UpdateUserCommand,
  type UserAdministrationService,
  type UserAdministrationServiceDependencies,
} from "./users/user-management.js";

export {
  isTerminalInstanceStatus,
  isTerminalTaskStatus,
  TERMINAL_WORKFLOW_INSTANCE_STATUSES,
  TERMINAL_WORKFLOW_TASK_STATUSES,
  WORKFLOW_INSTANCE_STATUSES,
  WORKFLOW_TASK_STATUSES,
  type WorkflowAssigneeTarget,
  type WorkflowDecisionEntity,
  type WorkflowDecisionType,
  type WorkflowDefinitionVersionEntity,
  type WorkflowInstanceEntity,
  type WorkflowInstanceStatus,
  type WorkflowStepDefinition,
  type WorkflowTaskEntity,
  type WorkflowTaskStatus,
} from "./workflows/workflow.types.js";
