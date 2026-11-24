import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { documents } from "./documents.js";
import { organizations, users } from "./identity.js";
import { categories } from "./taxonomy.js";

export const auditResultEnum = pgEnum("audit_result", ["SUCCESS", "DENIED", "FAILURE"]);

export const retentionActionEnum = pgEnum("retention_action", ["ARCHIVE", "TRASH", "PURGE"]);

export const outboxStatusEnum = pgEnum("outbox_status", ["PENDING", "PUBLISHED", "FAILED"]);

export type AuditMetadataJson = Record<string, string | number | boolean | null>;

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    action: varchar("action", { length: 120 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }).notNull(),
    resourceId: uuid("resource_id"),
    result: auditResultEnum("result").notNull(),
    requestId: uuid("request_id").notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    metadata: jsonb("metadata").$type<AuditMetadataJson>().notNull().default({}),
  },
  (table) => [
    index("audit_events_org_occurred_idx").on(table.organizationId, table.occurredAt, table.id),
    index("audit_events_org_actor_idx").on(
      table.organizationId,
      table.actorUserId,
      table.occurredAt,
    ),
    index("audit_events_resource_idx").on(table.resourceType, table.resourceId),
  ],
);

export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 120 }).notNull(),
    retentionDays: integer("retention_days").notNull(),
    trashGraceDays: integer("trash_grace_days").notNull().default(30),
    actionOnExpiry: retentionActionEnum("action_on_expiry").notNull().default("TRASH"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("retention_policies_org_name_unique").on(table.organizationId, table.name),
    check("retention_policies_days_pos_chk", sql`${table.retentionDays} >= 1`),
    check("retention_policies_grace_pos_chk", sql`${table.trashGraceDays} >= 1`),
  ],
);

export const documentRetentionHolds = pgTable(
  "document_retention_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    reason: varchar("reason", { length: 500 }).notNull(),
    placedByUserId: uuid("placed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    placedAt: timestamp("placed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    releasedByUserId: uuid("released_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
    releaseReason: varchar("release_reason", { length: 500 }),
  },
  (table) => [
    index("document_retention_holds_doc_released_idx").on(table.documentId, table.releasedAt),
    check(
      "document_retention_holds_release_after_place_chk",
      sql`${table.releasedAt} IS NULL OR ${table.releasedAt} >= ${table.placedAt}`,
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    aggregateType: varchar("aggregate_type", { length: 64 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: outboxStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    lastError: varchar("last_error", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("outbox_events_status_available_idx").on(table.status, table.availableAt),
    check("outbox_events_attempts_non_neg_chk", sql`${table.attempts} >= 0`),
  ],
);
