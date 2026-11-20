import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  doublePrecision,
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
import { fileObjects } from "./storage.js";
import { categories, categoryFields, folders, tags } from "./taxonomy.js";

export const documentStatusEnum = pgEnum("document_status", [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "ARCHIVED",
  "EXPIRED",
  "DELETED",
]);

export type DocumentMetadataColumnValue = string | number | boolean | null | string[];

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 255 }).notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "restrict" }),
    status: documentStatusEnum("status").notNull().default("DRAFT"),
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => documentVersions.id,
      { onDelete: "restrict" },
    ),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    issueDate: date("issue_date", { mode: "string" }),
    expirationDate: date("expiration_date", { mode: "string" }),
    metadata: jsonb("metadata")
      .$type<Record<string, DocumentMetadataColumnValue>>()
      .notNull()
      .default({}),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("documents_version_positive_chk", sql`${table.version} >= 1`),
    check(
      "documents_expiration_after_issue_chk",
      sql`${table.expirationDate} IS NULL OR ${table.issueDate} IS NULL OR ${table.expirationDate} >= ${table.issueDate}`,
    ),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    fileObjectId: uuid("file_object_id")
      .notNull()
      .references(() => fileObjects.id, { onDelete: "restrict" }),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    changeNote: varchar("change_note", { length: 1000 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("document_versions_doc_number_unique").on(table.documentId, table.versionNumber),
    check("document_versions_number_positive_chk", sql`${table.versionNumber} >= 1`),
  ],
);

export const documentMetadata = pgTable(
  "document_metadata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => categoryFields.id, { onDelete: "restrict" }),
    fieldKey: varchar("field_key", { length: 64 }).notNull(),
    valueText: text("value_text"),
    valueNumber: doublePrecision("value_number"),
    valueDate: date("value_date", { mode: "string" }),
    valueBoolean: boolean("value_boolean"),
    valueJson: jsonb("value_json").$type<string[] | null>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("document_metadata_doc_field_unique").on(table.documentId, table.fieldId),
  ],
);

export const documentTags = pgTable(
  "document_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("document_tags_doc_tag_unique").on(table.documentId, table.tagId)],
);
