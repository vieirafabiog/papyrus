import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const userStatusEnum = pgEnum("user_status", ["ACTIVE", "INACTIVE", "LOCKED"]);

export const accessActionEnum = pgEnum("access_action", [
  "READ",
  "CREATE",
  "UPDATE",
  "DELETE",
  "UPLOAD",
  "DOWNLOAD",
  "APPROVE",
  "REJECT",
  "MANAGE_PERMISSIONS",
  "MANAGE_STORAGE",
  "MANAGE_USERS",
  "VIEW_AUDIT",
]);

export const accessResourceEnum = pgEnum("access_resource", [
  "DOCUMENT",
  "FOLDER",
  "CATEGORY",
  "WORKFLOW",
  "USER",
  "GROUP",
  "ROLE",
  "STORAGE",
  "AUDIT",
  "ORGANIZATION",
]);

export const accessScopeTypeEnum = pgEnum("access_scope_type", [
  "GLOBAL",
  "CATEGORY",
  "FOLDER",
  "DOCUMENT",
]);

export const accessEffectEnum = pgEnum("access_effect", ["ALLOW", "DENY"]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  defaultLanguage: varchar("default_language", { length: 16 }).notNull().default("pt-BR"),
  timezone: varchar("timezone", { length: 64 }).notNull().default("America/Sao_Paulo"),
  logoObjectKey: varchar("logo_object_key", { length: 512 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    email: varchar("email", { length: 255 }).notNull(),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    status: userStatusEnum("status").notNull().default("ACTIVE"),
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_org_email_unique").on(table.organizationId, table.email),
    index("users_org_status_idx").on(table.organizationId, table.status),
    index("users_org_created_idx").on(table.organizationId, table.createdAt),
    check("users_email_lowercase_chk", sql`${table.email} = lower(${table.email})`),
  ],
);

export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("groups_org_name_unique").on(table.organizationId, table.name)],
);

export const userGroups = pgTable(
  "user_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_groups_user_group_unique").on(table.userId, table.groupId),
    index("user_groups_group_idx").on(table.groupId),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    key: varchar("key", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("roles_org_key_unique").on(table.organizationId, table.key)],
);

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: accessActionEnum("action").notNull(),
    resource: accessResourceEnum("resource").notNull(),
    description: varchar("description", { length: 255 }),
  },
  (table) => [uniqueIndex("permissions_action_resource_unique").on(table.action, table.resource)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("role_permissions_role_perm_unique").on(table.roleId, table.permissionId)],
);

export const userRoleScopes = pgTable(
  "user_role_scopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
    groupId: uuid("group_id").references(() => groups.id, { onDelete: "restrict" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    scopeType: accessScopeTypeEnum("scope_type").notNull(),
    scopeTargetId: uuid("scope_target_id"),
    effect: accessEffectEnum("effect").notNull().default("ALLOW"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("user_role_scopes_org_user_idx").on(table.organizationId, table.userId),
    index("user_role_scopes_org_group_idx").on(table.organizationId, table.groupId),
    index("user_role_scopes_scope_idx").on(table.scopeType, table.scopeTargetId),
    check(
      "user_role_scopes_subject_chk",
      sql`(${table.userId} IS NOT NULL AND ${table.groupId} IS NULL) OR (${table.userId} IS NULL AND ${table.groupId} IS NOT NULL)`,
    ),
    check(
      "user_role_scopes_target_chk",
      sql`(${table.scopeType} = 'GLOBAL' AND ${table.scopeTargetId} IS NULL) OR (${table.scopeType} <> 'GLOBAL' AND ${table.scopeTargetId} IS NOT NULL)`,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
    check("sessions_expires_after_created_chk", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);
