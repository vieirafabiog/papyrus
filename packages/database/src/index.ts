export const DATABASE_SCHEMA_VERSION = 1 as const;

export {
  createDatabaseClient,
  type DatabaseClient,
  type DatabaseClientOptions,
  type DatabaseLogger,
  sanitizeDatabaseErrorMessage,
} from "./client.js";

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
