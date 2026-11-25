import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { categories } from "./taxonomy.js";

export const storageConnectionKindEnum = pgEnum("storage_connection_kind", [
  "local",
  "s3",
  "sharepoint",
  "azure_blob",
  "google_cloud",
]);

export const storageConnectionStatusEnum = pgEnum("storage_connection_status", [
  "ACTIVE",
  "INACTIVE",
  "ERROR",
]);

export const fileObjectStatusEnum = pgEnum("file_object_status", [
  "UPLOADING",
  "QUARANTINED",
  "AVAILABLE",
  "REJECTED",
  "MISSING",
  "DELETE_PENDING",
]);

export const uploadSessionStatusEnum = pgEnum("upload_session_status", [
  "PENDING",
  "UPLOADED",
  "FINALIZED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
]);

export const storageOperationTypeEnum = pgEnum("storage_operation_type", [
  "COPY",
  "DELETE",
  "VERIFY_CHECKSUM",
]);

export const storageOperationStatusEnum = pgEnum("storage_operation_status", [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
]);

export const storageConnections = pgTable(
  "storage_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 120 }).notNull(),
    kind: storageConnectionKindEnum("kind").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    status: storageConnectionStatusEnum("status").notNull().default("ACTIVE"),
    nonSecretConfig: jsonb("non_secret_config")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    encryptedSecretPayload: text("encrypted_secret_payload"),
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true, mode: "date" }),
    lastHealthMessage: varchar("last_health_message", { length: 500 }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("storage_connections_org_name_unique").on(table.organizationId, table.name),
    uniqueIndex("storage_connections_org_default_unique")
      .on(table.organizationId)
      .where(sql`${table.isDefault} = true`),
    index("storage_connections_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const storageRoutingRules = pgTable(
  "storage_routing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "restrict" }),
    storageConnectionId: uuid("storage_connection_id")
      .notNull()
      .references(() => storageConnections.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("storage_routing_rules_org_cat_unique").on(table.organizationId, table.categoryId),
    uniqueIndex("storage_routing_rules_org_default_unique")
      .on(table.organizationId)
      .where(sql`${table.categoryId} IS NULL`),
  ],
);

export const fileObjects = pgTable(
  "file_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    storageConnectionId: uuid("storage_connection_id")
      .notNull()
      .references(() => storageConnections.id, { onDelete: "restrict" }),
    objectKey: varchar("object_key", { length: 512 }).notNull(),
    originalFileName: varchar("original_file_name", { length: 255 }).notNull(),
    detectedContentType: varchar("detected_content_type", { length: 255 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
    status: fileObjectStatusEnum("status").notNull().default("UPLOADING"),
    rejectionReason: varchar("rejection_reason", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("file_objects_conn_key_unique").on(table.storageConnectionId, table.objectKey),
    index("file_objects_org_status_idx").on(table.organizationId, table.status),
    index("file_objects_conn_idx").on(table.storageConnectionId),
    check("file_objects_size_non_neg_chk", sql`${table.sizeBytes} >= 0`),
    check("file_objects_sha256_hex_chk", sql`${table.checksumSha256} ~ '^[0-9a-fA-F]{64}$'`),
  ],
);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    storageConnectionId: uuid("storage_connection_id")
      .notNull()
      .references(() => storageConnections.id, { onDelete: "restrict" }),
    fileObjectId: uuid("file_object_id")
      .notNull()
      .references(() => fileObjects.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    declaredSizeBytes: bigint("declared_size_bytes", { mode: "number" }).notNull(),
    declaredContentType: varchar("declared_content_type", { length: 255 }).notNull(),
    indexContentRequested: boolean("index_content_requested"),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    status: uploadSessionStatusEnum("status").notNull().default("PENDING"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("upload_sessions_idempotency_unique").on(
      table.organizationId,
      table.userId,
      table.idempotencyKey,
    ),
    index("upload_sessions_org_status_exp_idx").on(
      table.organizationId,
      table.status,
      table.expiresAt,
    ),
    index("upload_sessions_file_obj_idx").on(table.fileObjectId),
    check("upload_sessions_size_positive_chk", sql`${table.declaredSizeBytes} > 0`),
    check(
      "upload_sessions_expires_after_created_chk",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const storageOperations = pgTable(
  "storage_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    fileObjectId: uuid("file_object_id")
      .notNull()
      .references(() => fileObjects.id, { onDelete: "restrict" }),
    storageConnectionId: uuid("storage_connection_id")
      .notNull()
      .references(() => storageConnections.id, { onDelete: "restrict" }),
    operationType: storageOperationTypeEnum("operation_type").notNull(),
    status: storageOperationStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: varchar("last_error", { length: 500 }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("storage_operations_status_next_idx").on(table.status, table.nextAttemptAt),
    index("storage_operations_file_obj_idx").on(table.fileObjectId),
    check("storage_operations_attempts_non_neg_chk", sql`${table.attempts} >= 0`),
    check("storage_operations_max_attempts_pos_chk", sql`${table.maxAttempts} >= 1`),
  ],
);
