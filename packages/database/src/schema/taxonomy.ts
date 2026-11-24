import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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

export const folderStatusEnum = pgEnum("folder_status", ["ACTIVE", "ARCHIVED"]);

export const categoryFieldTypeEnum = pgEnum("category_field_type", [
  "TEXT",
  "NUMBER",
  "DATE",
  "BOOLEAN",
  "SINGLE_SELECT",
  "MULTI_SELECT",
]);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, {
      onDelete: "restrict",
    }),
    name: varchar("name", { length: 120 }).notNull(),
    materializedPath: text("materialized_path").notNull(),
    status: folderStatusEnum("status").notNull().default("ACTIVE"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("folders_org_parent_name_unique").on(
      table.organizationId,
      table.parentId,
      table.name,
    ),
    uniqueIndex("folders_org_root_name_unique")
      .on(table.organizationId, table.name)
      .where(sql`${table.parentId} IS NULL`),
    index("folders_org_parent_status_idx").on(table.organizationId, table.parentId, table.status),
    index("folders_org_path_idx").on(table.organizationId, table.materializedPath),
    check(
      "folders_no_self_parent_chk",
      sql`${table.parentId} IS NULL OR ${table.parentId} <> ${table.id}`,
    ),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    color: varchar("color", { length: 7 }),
    icon: varchar("icon", { length: 64 }),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("categories_org_name_unique").on(table.organizationId, table.name),
    index("categories_org_active_idx").on(table.organizationId, table.isActive),
  ],
);

export const categoryFields = pgTable(
  "category_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    key: varchar("key", { length: 64 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    type: categoryFieldTypeEnum("type").notNull(),
    required: boolean("required").notNull().default(false),
    options: jsonb("options").$type<string[] | null>(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("category_fields_cat_key_unique").on(table.categoryId, table.key),
    index("category_fields_cat_order_idx").on(table.categoryId, table.sortOrder),
    check("category_fields_sort_order_non_neg_chk", sql`${table.sortOrder} >= 0`),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 64 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 64 }).notNull(),
    color: varchar("color", { length: 7 }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tags_org_normalized_name_unique").on(table.organizationId, table.normalizedName),
    check(
      "tags_normalized_lowercase_chk",
      sql`${table.normalizedName} = lower(${table.normalizedName})`,
    ),
  ],
);
