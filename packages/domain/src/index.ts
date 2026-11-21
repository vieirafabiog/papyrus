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
  validateFieldValueForDefinition,
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
  type DocumentDetailCategoryFieldSummary,
  type DocumentDetailQueryData,
  type DocumentEntity,
  type DocumentListItemEntity,
  type DocumentMetadataMap,
  type DocumentMetadataValue,
  type DocumentStatus,
  type DocumentVersionEntity,
  type DocumentVersionHistoryQueryItem,
  FILE_OBJECT_STATUSES,
  type FileObjectEntity,
  type FileObjectStatus,
} from "./documents/document.types.js";

export {
  type CreateDocumentCommand,
  type CreatedDocumentResult,
  type CreateDocumentService,
  type CreateDocumentServiceDependencies,
  createDocumentUseCase,
  MAX_DOCUMENT_TITLE_LENGTH,
  normalizeDocumentTitle,
  resolveInitialDocumentStatus,
} from "./documents/create-document.js";

export {
  type CreatedDocumentVersionResult,
  type CreateDocumentVersionService,
  type CreateDocumentVersionServiceDependencies,
  createDocumentVersionUseCase,
  type CreateNewDocumentVersionCommand,
  type RestoreDocumentVersionCommand,
} from "./documents/create-version.js";

export {
  type ArchiveDocumentCommand,
  type ArchiveDocumentService,
  type ArchiveDocumentServiceDependencies,
  archiveDocumentUseCase,
} from "./documents/archive-document.js";

export {
  type MoveDocumentCommand,
  type MoveDocumentService,
  type MoveDocumentServiceDependencies,
  moveDocumentUseCase,
} from "./documents/move-document.js";

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
  type FinalizeUploadToQuarantineInput,
  type MarkFileObjectProcessedInput,
  type MarkUploadReceivedInput,
  UPLOAD_SESSION_STATUSES,
  type UploadSessionEntity,
  type UploadSessionRepositoryPort,
  type UploadSessionStatus,
} from "./ports/upload-session-repository.port.js";

export {
  createFinalizeUploadService,
  type FinalizeUploadCommand,
  type FinalizeUploadResult,
  type FinalizeUploadService,
  type FinalizeUploadServiceDependencies,
  type UploadObjectVerifierPort,
  type UploadProcessingEnqueueInput,
  type UploadProcessingQueuePort,
  type VerifiedUploadedObject,
} from "./uploads/finalize-upload.js";

export {
  type CreateUploadSessionCommand,
  type CreateUploadSessionResult,
  createUploadSessionService,
  type UploadSessionService,
  type UploadSessionServiceDependencies,
} from "./uploads/upload-sessions.js";

export {
  type CategoryFieldService,
  type CategoryFieldServiceDependencies,
  type CreateCategoryFieldCommand,
  createCategoryFieldService,
  type FieldMigrationStrategy,
  normalizeCategoryFieldKey,
  normalizeCategoryFieldLabel,
  normalizeCategoryFieldOptions,
  type RemoveCategoryFieldCommand,
  resolveFieldChangePlan,
  type UpdateCategoryFieldCommand,
} from "./categories/category-field-service.js";
export {
  type CategoryService,
  type CategoryServiceDependencies,
  type CreateCategoryCommand,
  createCategoryService,
  type DeactivateCategoryCommand,
  MAX_CATEGORY_DESCRIPTION_LENGTH,
  MAX_CATEGORY_ICON_LENGTH,
  MAX_CATEGORY_NAME_LENGTH,
  normalizeCategoryColor,
  normalizeCategoryDescription,
  normalizeCategoryIcon,
  normalizeCategoryName,
  type UpdateCategoryCommand,
} from "./categories/category-service.js";
export type {
  AuthorizedCategoryQueryScope,
  CategoryEntity,
  CategoryFieldEntity,
  CategoryListFilter,
  CategorySortField,
} from "./categories/category.types.js";
export type {
  CategoryRepositoryPort,
  CreateCategoryFieldRecordInput,
  CreateCategoryInput,
  ExistingDocumentMetadataSnapshot,
  UpdateCategoryFieldRecordInput,
  UpdateCategoryInput,
} from "./ports/category-repository.port.js";

export {
  buildFolderMaterializedPath,
  type ArchiveFolderCommand,
  type CreateFolderCommand,
  createFolderService,
  type FolderService,
  type FolderServiceDependencies,
  isFolderHierarchyCycle,
  MAX_FOLDER_NAME_LENGTH,
  type MoveFolderCommand,
  normalizeFolderName,
  type RenameFolderCommand,
} from "./folders/folder-service.js";
export {
  type AuthorizedFolderQueryScope,
  FOLDER_STATUSES,
  type FolderEntity,
  type FolderListFilter,
  type FolderSortField,
  type FolderStatus,
} from "./folders/folder.types.js";
export type {
  ArchiveFolderInput,
  CreateFolderInput,
  FolderRepositoryPort,
  MoveFolderSubtreeInput,
  RenameFolderInput,
} from "./ports/folder-repository.port.js";

export {
  type AttachDocumentTagCommand,
  createTagService,
  type CreateTagCommand,
  type DetachDocumentTagCommand,
  MAX_TAG_NAME_LENGTH,
  normalizeTagName,
  type TagService,
  type TagServiceDependencies,
} from "./tags/tag-service.js";
export type { TagEntity, TagListFilter, TagSortField } from "./tags/tag.types.js";
export type {
  AttachDocumentTagRecordInput,
  CreateTagRecordInput,
  TagRepositoryPort,
} from "./ports/tag-repository.port.js";

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
