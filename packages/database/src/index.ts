export const DATABASE_SCHEMA_VERSION = 1 as const;

export {
  createDatabaseClient,
  type DatabaseClient,
  type DatabaseClientOptions,
  type DatabaseLogger,
  sanitizeDatabaseErrorMessage,
} from "./client.js";

export { createAuditRepository } from "./repositories/audit-repository.js";
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
export { createFolderRepository } from "./repositories/folder-repository.js";
export { createGroupRepository } from "./repositories/group-repository.js";
export {
  type ClaimOutboxJobOptions,
  createOutboxRepository,
  type EnqueueOutboxEventInput,
  type OutboxJobRecord,
  type OutboxRepository,
  type RetryOrFailOutboxJobInput,
  UPLOAD_PROCESSING_EVENT_TYPE,
} from "./repositories/outbox-repository.js";
export {
  createStorageConnectionRepository,
  createStorageRoutingRuleRepository,
} from "./repositories/storage-connection-repository.js";
export {
  createTransactionManager,
  type DrizzleDbExecutor,
  resolveDbExecutor,
} from "./repositories/transaction-manager.js";
export { createUploadSessionRepository } from "./repositories/upload-session-repository.js";
export { createUserRepository } from "./repositories/user-repository.js";

export {
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
