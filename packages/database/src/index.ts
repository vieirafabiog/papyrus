export const DATABASE_SCHEMA_VERSION = 1 as const;

export {
  createDatabaseClient,
  type DatabaseClient,
  type DatabaseClientOptions,
  type DatabaseLogger,
  sanitizeDatabaseErrorMessage,
} from "./client.js";

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
