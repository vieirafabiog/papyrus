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
  type AssignRoleScopeCommand,
  createPermissionAdministrationService,
  type PermissionAdministrationDependencies,
  type PermissionAdministrationService,
  type RevokeRoleScopeCommand,
} from "./access/permission-service.js";

export {
  ALLOWED_ORGANIZATION_PAGE_SIZES,
  DEFAULT_ORGANIZATION_PREFERENCES,
  type OrganizationDateFormat,
  type OrganizationEntity,
  type OrganizationLanguage,
  type OrganizationListPageSize,
  type OrganizationPreferences,
  SUPPORTED_ORGANIZATION_DATE_FORMATS,
  SUPPORTED_ORGANIZATION_LANGUAGES,
} from "./organization/organization.types.js";

export {
  createOrganizationService,
  MAX_EXPIRATION_PREFERENCE_DAYS,
  MAX_ORGANIZATION_NAME_LENGTH,
  MAX_TRASH_GRACE_PREFERENCE_DAYS,
  MIN_ORGANIZATION_NAME_LENGTH,
  normalizeOrganizationLanguage,
  normalizeOrganizationPreferences,
  type OrganizationPreferencesPatch,
  type OrganizationService,
  type OrganizationServiceDependencies,
  type UpdateOrganizationCommand,
} from "./organization/organization-service.js";

export type {
  OrganizationRepositoryPort,
  UpdateOrganizationSettingsInput,
} from "./ports/organization-repository.port.js";

export type {
  CreateRoleScopeAssignmentInput,
  PermissionScopeRepositoryPort,
  PermissionSubjectType,
  RoleScopeAssignmentRecord,
  RoleWithPermissionsRecord,
} from "./ports/permission-repository.port.js";

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
  addCalendarDays,
  classifyExpirationState,
  DEFAULT_EXPIRATION_TIMEZONE,
  DEFAULT_EXPIRATION_WINDOW_DAYS,
  diffCalendarDays,
  DOCUMENT_EXPIRATION_BUCKETS,
  DOCUMENT_EXPIRATION_STATES,
  type DocumentExpirationBucket,
  type DocumentExpirationState,
  isValidIanaTimeZone,
  MAX_EXPIRATION_WINDOW_DAYS,
  resolveLocalCalendarDate,
} from "./documents/expiration.js";

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
  type TrashDocumentCommand,
  type TrashDocumentService,
  type TrashDocumentServiceDependencies,
  trashDocumentUseCase,
} from "./documents/trash-document.js";

export {
  evaluateTrashRestoreWindow,
  type RestorableDocumentTargetStatus,
  type RestoreDocumentCommand,
  type RestoreDocumentService,
  type RestoreDocumentServiceDependencies,
  restoreDocumentUseCase,
} from "./documents/restore-document.js";

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

export {
  type AuditWriter,
  type AuditWriterDependencies,
  buildMinimalAuditEvent,
  createAuditWriter,
  MAX_AUDIT_ACTION_LENGTH,
  MAX_AUDIT_IP_LENGTH,
  MAX_AUDIT_METADATA_KEYS,
  MAX_AUDIT_METADATA_STRING_LENGTH,
  MAX_AUDIT_RESOURCE_TYPE_LENGTH,
  redactSensitiveAuditString,
  sanitizeAuditMetadata,
  type WriteAuditEventInput,
} from "./audit/audit-writer.js";

export type {
  AuditActorSummary,
  AuditEventInput,
  AuditEventRecord,
  AuditExportFilter,
  AuditFacetsRecord,
  AuditListFilter,
  AuditMetadataValue,
  AuditRepositoryPort,
  AuditResult,
  AuditSortField,
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
  type DocumentTextIndexingEnqueueInput,
  type DocumentTextIndexingQueuePort,
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
  normalizeCategoryTextIndexingMode,
  resolveCategoryTextIndexingDecision,
  type UpdateCategoryCommand,
} from "./categories/category-service.js";
export {
  CATEGORY_TEXT_INDEXING_MODES,
  type CategoryTextIndexingMode,
} from "./categories/category.types.js";
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

export type {
  CreatedWorkflowDefinitionRecords,
  CreateWorkflowDefinitionRecordInput,
  PublishWorkflowDefinitionVersionInput,
  UpdateWorkflowDefinitionInput,
  WorkflowDefinitionRepositoryPort,
} from "./ports/workflow-definition-repository.port.js";

export type {
  CreateWorkflowInstanceRecordInput,
  UpdateWorkflowInstanceProgressInput,
  WorkflowInstanceRepositoryPort,
} from "./ports/workflow-instance-repository.port.js";

export type {
  CreateWorkflowDecisionRecordInput,
  CreateWorkflowTaskIdempotentInput,
  CreateWorkflowTaskRecordResult,
  TransitionWorkflowTaskFromPendingInput,
  WorkflowDecisionRepositoryPort,
  WorkflowTaskRepositoryPort,
} from "./ports/workflow-task-repository.port.js";

export {
  type CreateWorkflowTasksDependencies,
  type CreateWorkflowTasksService,
  createWorkflowTasksUseCase,
  type GeneratedWorkflowTaskResult,
  type GenerateWorkflowStepTaskCommand,
  type WorkflowAssigneeAuthorizationPort,
} from "./workflows/create-tasks.js";

export {
  createDecideTaskUseCase,
  type DecideTaskAction,
  type DecideTaskCommand,
  type DecideTaskDependencies,
  type DecideTaskService,
  type DecidedTaskResult,
} from "./workflows/decide-task.js";

export {
  createStartWorkflowUseCase,
  type StartWorkflowCommand,
  type StartedWorkflowResult,
  type StartWorkflowService,
  type StartWorkflowServiceDependencies,
} from "./workflows/start-workflow.js";

export type {
  ClaimPurgeDocumentOutcome,
  DocumentPurgeStorePort,
  PurgeCandidateRecord,
  PurgeStorageDeletionTarget,
} from "./ports/document-purge.port.js";

export type {
  CreateDocumentRetentionHoldInput,
  CreateRetentionPolicyInput,
  DocumentRetentionHoldRepositoryPort,
  ReleaseDocumentRetentionHoldInput,
  RetentionPolicyRepositoryPort,
  UpdateRetentionPolicyInput,
} from "./ports/retention-repository.port.js";

export {
  type DocumentRetentionHoldEntity,
  PURGE_BLOCK_REASONS,
  type PurgeBlockReason,
  type PurgeEligibilityEvaluation,
  RETENTION_ACTIONS,
  type RetentionAction,
  type RetentionPolicyEntity,
} from "./retention/retention.types.js";

export {
  type CheckDocumentPurgeInput,
  type CreateRetentionPolicyCommand,
  createRetentionGovernanceService,
  DEFAULT_TRASH_GRACE_DAYS,
  type EvaluatePurgeInput,
  evaluateDocumentPurgeEligibility,
  MAX_HOLD_REASON_LENGTH,
  MAX_RETENTION_DAYS,
  MAX_RETENTION_POLICY_NAME_LENGTH,
  MAX_TRASH_GRACE_DAYS,
  type PlaceDocumentHoldCommand,
  type ReleaseDocumentHoldCommand,
  type RetentionGovernanceDependencies,
  type RetentionGovernanceService,
  selectApplicableRetentionPolicy,
  type UpdateRetentionPolicyCommand,
} from "./retention/retention-service.js";

export {
  calculateStepDueAt,
  cloneAndValidateWorkflowAssignee,
  type CreateWorkflowDefinitionCommand,
  createWorkflowDefinitionService,
  MAX_WORKFLOW_DECISION_COMMENT_LENGTH,
  MAX_WORKFLOW_DEFINITION_DESCRIPTION_LENGTH,
  MAX_WORKFLOW_DEFINITION_NAME_LENGTH,
  MAX_WORKFLOW_STEP_DUE_DAYS,
  MAX_WORKFLOW_STEP_NAME_LENGTH,
  MAX_WORKFLOW_STEPS,
  normalizeWorkflowDefinitionDescription,
  normalizeWorkflowDefinitionName,
  normalizeWorkflowStepName,
  type PublishWorkflowDefinitionVersionCommand,
  requiresCommentForDecision,
  resolveStepCommentRules,
  type UpdateWorkflowDefinitionStatusCommand,
  validateDecisionComment,
  validateSequentialWorkflowSteps,
  type WorkflowDefinitionService,
  type WorkflowDefinitionServiceDependencies,
  type WorkflowDefinitionWithVersions,
  type WorkflowStepCommentRulesInput,
  type WorkflowStepDefinitionInput,
} from "./workflows/definitions/index.js";

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
  type WorkflowDefinitionEntity,
  type WorkflowDefinitionVersionEntity,
  type WorkflowInstanceEntity,
  type WorkflowInstanceStatus,
  type WorkflowStepCommentRules,
  type WorkflowStepDefinition,
  type WorkflowTaskEntity,
  type WorkflowTaskStatus,
} from "./workflows/workflow.types.js";

export {
  createUploadLimitsService,
  DOMAIN_DEFAULT_PROXY_MAX_BODY_BYTES,
  DOMAIN_DEFAULT_UPLOAD_ALLOWED_EXTENSIONS,
  DOMAIN_DEFAULT_UPLOAD_MAX_BYTES,
  DOMAIN_MAX_SYSTEM_UPLOAD_BYTES,
  DOMAIN_MIN_UPLOAD_MAX_BYTES,
  DOMAIN_SAFE_UPLOAD_FORMAT_CATALOG,
  type EffectiveUploadPolicy,
  extractNormalizedFileExtension,
  normalizeDeclaredUploadMimeType,
  resolveMimeTypesForExtensions,
  type SafeDomainFormatRule,
  type StoredUploadLimitsRecord,
  type UpdateUploadLimitsCommand,
  type UploadLimitsConfig,
  type UploadLimitsService,
  type UploadLimitsServiceDependencies,
  type UploadLimitsView,
  type UploadPolicyRepositoryPort,
} from "./uploads/upload-policy.js";

export {
  type CreateDocumentCommentCommand,
  type CreateDocumentCommentRecordInput,
  createDocumentCommentService,
  type DeleteDocumentCommentCommand,
  type DocumentCommentEntity,
  type DocumentCommentMentionEntity,
  type DocumentCommentMentionNotifierPort,
  type DocumentCommentParticipantEntity,
  type DocumentCommentRepositoryPort,
  type DocumentCommentService,
  type DocumentCommentServiceDependencies,
  MAX_DOCUMENT_COMMENT_BODY_LENGTH,
  MAX_DOCUMENT_COMMENT_MENTION_IDS,
} from "./documents/document-comments.js";

export {
  computeShareLinkStatus,
  type CreateDocumentShareLinkCommand,
  type CreateDocumentShareLinkRecordInput,
  createDocumentShareService,
  type DocumentShareLinkEntity,
  type DocumentShareLinkRepositoryPort,
  type DocumentShareService,
  type DocumentShareServiceDependencies,
  type PublicShareDeliveryTarget,
  type PublicShareMetadataResult,
  type RevokeDocumentShareLinkCommand,
  SHARE_MAX_PASSCODE_LENGTH,
  SHARE_MAX_TTL_MINUTES,
  SHARE_MAX_USES_LIMIT,
  SHARE_MIN_PASSCODE_LENGTH,
  SHARE_MIN_TTL_MINUTES,
  SHARE_UNLOCK_TTL_SECONDS,
  type ShareDeliveryMode,
  type ShareLinkCryptoPort,
  type ShareLinkStatus,
} from "./documents/document-share.js";
