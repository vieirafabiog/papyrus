export const DATABASE_SCHEMA_VERSION = 1 as const;

export {
  createDatabaseClient,
  type DatabaseClient,
  type DatabaseClientOptions,
  type DatabaseLogger,
  sanitizeDatabaseErrorMessage,
} from "./client.js";

export {
  assertDestructiveSeedAllowed,
  DEFAULT_MIGRATION_LOCK_RETRY_INTERVAL_MS,
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  DOCUFLOW_MIGRATION_ADVISORY_LOCK_KEY,
  isProductionNodeEnv,
  MigrationGuardError,
  MigrationLockTimeoutError,
  resolveDefaultMigrationsFolder,
  runMigrationsWithAdvisoryLock,
  type RunMigrationsOptions,
  type RunMigrationsResult,
} from "./migrations/safe-migrator.js";

export { createAuditRepository } from "./repositories/audit-repository.js";
export { createPermissionScopeRepository } from "./repositories/permission-repository.js";
export {
  type AuthorizationRepository,
  type AuthorizedDocumentQueryScope,
  createAuthorizationRepository,
  type LoadedAuthorizationSubject,
  type LoadedRoleAssignment,
  type LoadedRolePermission,
} from "./repositories/authorization-repository.js";
export { createCategoryRepository } from "./repositories/category-repository.js";
export {
  createDocumentRepository,
  createDocumentVersionRepository,
} from "./repositories/document-repository.js";
export {
  createDocumentExpirationRepository,
  type DocumentExpirationListItemRecord,
  type DocumentExpirationRepository,
  type DocumentExpirationsFilter,
  type DocumentExpirationsQueryResult,
  type DocumentExpirationsSummaryRecord,
  type DocumentExpirationSortField,
} from "./repositories/document-expiration-repository.js";
export {
  createDocumentTrashRepository,
  type DocumentTrashFilter,
  type DocumentTrashListItemRecord,
  type DocumentTrashRepository,
  type DocumentTrashSortField,
} from "./repositories/document-trash-repository.js";
export {
  createDashboardRepository,
  type DashboardRecentActivityRecord,
  type DashboardRepository,
  type DashboardSummaryQueryInput,
  type DashboardSummaryRecord,
} from "./repositories/dashboard-repository.js";
export {
  createDocumentSearchRepository,
  type DocumentMetadataSearchFilter,
  type DocumentSearchFilter,
  type DocumentSearchRepository,
} from "./repositories/document-search.js";
export { createFolderRepository } from "./repositories/folder-repository.js";
export { createGroupRepository } from "./repositories/group-repository.js";
export { createInAppNotificationRepository } from "./repositories/notification-repository.js";
export {
  type ClaimOutboxJobOptions,
  createOutboxRepository,
  type EnqueueOutboxEventInput,
  type OutboxJobRecord,
  type OutboxRepository,
  type RetryOrFailOutboxJobInput,
  UPLOAD_PROCESSING_EVENT_TYPE,
} from "./repositories/outbox-repository.js";
export { createOrganizationRepository } from "./repositories/organization-repository.js";
export { createUploadPolicyRepository } from "./repositories/upload-policy-repository.js";
export {
  createDocumentRetentionHoldRepository,
  createRetentionPolicyRepository,
} from "./repositories/retention-repository.js";
export { createDocumentPurgeRepository } from "./repositories/document-purge-repository.js";
export {
  createStorageConnectionRepository,
  createStorageRoutingRuleRepository,
} from "./repositories/storage-connection-repository.js";
export { createTagRepository } from "./repositories/tag-repository.js";
export {
  createTaskInboxRepository,
  type TaskDetailLookupOutcome,
  type TaskInboxFilter,
  type TaskInboxRecord,
  type TaskInboxRepository,
  type TaskInboxSortField,
} from "./repositories/task-inbox-repository.js";
export {
  createTransactionManager,
  type DrizzleDbExecutor,
  resolveDbExecutor,
} from "./repositories/transaction-manager.js";
export { createUploadSessionRepository } from "./repositories/upload-session-repository.js";
export { createUserRepository } from "./repositories/user-repository.js";
export {
  createWorkflowAssigneeVerifier,
  createWorkflowDecisionRepository,
  createWorkflowDefinitionRepository,
  createWorkflowInstanceRepository,
  createWorkflowTaskRepository,
  createWorkflowTimelineRepository,
  type DocumentWorkflowTimelineRecord,
  type WorkflowTimelineDecisionRecord,
  type WorkflowTimelineRepository,
  type WorkflowTimelineStepRecord,
} from "./repositories/workflow-repository.js";

export {
  documentExtractedTexts,
  type DocumentMetadataColumnValue,
  documentMetadata,
  documentStatusEnum,
  documents,
  documentTags,
  documentVersions,
} from "./schema/documents.js";

export {
  auditEvents,
  type AuditMetadataJson,
  auditResultEnum,
  documentRetentionHolds,
  outboxEvents,
  outboxStatusEnum,
  retentionActionEnum,
  retentionPolicies,
} from "./schema/governance.js";

export {
  accessActionEnum,
  accessEffectEnum,
  accessResourceEnum,
  accessScopeTypeEnum,
  groups,
  type OrganizationPreferencesJson,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  userGroups,
  userRoleScopes,
  userStatusEnum,
  users,
} from "./schema/identity.js";

export {
  fileObjects,
  fileObjectStatusEnum,
  storageConnectionKindEnum,
  storageConnections,
  storageConnectionStatusEnum,
  storageOperations,
  storageOperationStatusEnum,
  storageOperationTypeEnum,
  storageRoutingRules,
  uploadSessions,
  uploadSessionStatusEnum,
} from "./schema/storage.js";

export {
  categories,
  categoryFields,
  categoryFieldTypeEnum,
  folders,
  folderStatusEnum,
  tags,
} from "./schema/taxonomy.js";

export {
  notificationChannelEnum,
  notifications,
  type WorkflowStepSnapshot,
  workflowAssigneeTypeEnum,
  workflowDecisions,
  workflowDecisionTypeEnum,
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowInstances,
  workflowInstanceStatusEnum,
  workflowTasks,
  workflowTaskStatusEnum,
} from "./schema/workflows.js";
