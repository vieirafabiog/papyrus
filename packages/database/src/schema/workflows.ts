import { sql } from "drizzle-orm";
import {
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
import { documentVersions, documents } from "./documents.js";
import { organizations, users } from "./identity.js";

export const workflowInstanceStatusEnum = pgEnum("workflow_instance_status", [
  "ACTIVE",
  "COMPLETED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "CANCELLED",
  "EXPIRED",
]);

export const workflowTaskStatusEnum = pgEnum("workflow_task_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "CANCELLED",
  "EXPIRED",
]);

export const workflowDecisionTypeEnum = pgEnum("workflow_decision_type", [
  "APPROVE",
  "REJECT",
  "REQUEST_CHANGES",
]);

export const workflowAssigneeTypeEnum = pgEnum("workflow_assignee_type", ["USER", "GROUP", "ROLE"]);

export const notificationChannelEnum = pgEnum("notification_channel", ["INTERNAL", "EMAIL"]);

export interface WorkflowStepSnapshot {
  stepOrder: number;
  name: string;
  assigneeType: "USER" | "GROUP" | "ROLE";
  assigneeTargetId: string;
  dueDays: number | null;
}

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    isActive: boolean("is_active").notNull().default(true),
    latestVersionNumber: integer("latest_version_number").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_definitions_org_name_unique").on(table.organizationId, table.name),
    check("workflow_definitions_version_non_neg_chk", sql`${table.latestVersionNumber} >= 0`),
  ],
);

export const workflowDefinitionVersions = pgTable(
  "workflow_definition_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowDefinitionId: uuid("workflow_definition_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    steps: jsonb("steps").$type<WorkflowStepSnapshot[]>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_def_versions_def_num_unique").on(
      table.workflowDefinitionId,
      table.versionNumber,
    ),
    check("workflow_def_versions_num_pos_chk", sql`${table.versionNumber} >= 1`),
  ],
);

export const workflowInstances = pgTable(
  "workflow_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    workflowDefinitionVersionId: uuid("workflow_definition_version_id")
      .notNull()
      .references(() => workflowDefinitionVersions.id, { onDelete: "restrict" }),
    status: workflowInstanceStatusEnum("status").notNull().default("ACTIVE"),
    currentStepOrder: integer("current_step_order").notNull().default(1),
    startedByUserId: uuid("started_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("workflow_instances_doc_status_idx").on(table.documentId, table.status),
    index("workflow_instances_doc_version_idx").on(table.documentVersionId),
    index("workflow_instances_org_status_idx").on(table.organizationId, table.status),
    check("workflow_instances_step_pos_chk", sql`${table.currentStepOrder} >= 1`),
  ],
);

export const workflowTasks = pgTable(
  "workflow_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    workflowInstanceId: uuid("workflow_instance_id")
      .notNull()
      .references(() => workflowInstances.id, { onDelete: "restrict" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    stepOrder: integer("step_order").notNull(),
    status: workflowTaskStatusEnum("status").notNull().default("PENDING"),
    assigneeType: workflowAssigneeTypeEnum("assignee_type").notNull(),
    assigneeTargetId: uuid("assignee_target_id").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("workflow_tasks_instance_step_unique").on(
      table.workflowInstanceId,
      table.stepOrder,
    ),
    index("workflow_tasks_org_status_due_idx").on(table.organizationId, table.status, table.dueAt),
    index("workflow_tasks_assignee_status_idx").on(
      table.assigneeType,
      table.assigneeTargetId,
      table.status,
    ),
    index("workflow_tasks_doc_idx").on(table.documentId),
    check("workflow_tasks_step_pos_chk", sql`${table.stepOrder} >= 1`),
  ],
);

export const workflowDecisions = pgTable(
  "workflow_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => workflowTasks.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decision: workflowDecisionTypeEnum("decision").notNull(),
    comment: varchar("comment", { length: 2000 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_decisions_task_unique").on(table.taskId),
    check(
      "workflow_decisions_comment_required_chk",
      sql`${table.decision} = 'APPROVE' OR (${table.comment} IS NOT NULL AND length(btrim(${table.comment})) > 0)`,
    ),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    channel: notificationChannelEnum("channel").notNull().default("INTERNAL"),
    kind: varchar("kind", { length: 64 }).notNull().default("TASK_ASSIGNED"),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body").notNull(),
    resourceType: varchar("resource_type", { length: 64 }),
    resourceId: uuid("resource_id"),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("notifications_recipient_read_created_idx").on(
      table.recipientUserId,
      table.readAt,
      table.createdAt,
    ),
    uniqueIndex("notifications_org_channel_recipient_idem_unique").on(
      table.organizationId,
      table.channel,
      table.recipientUserId,
      table.idempotencyKey,
    ),
  ],
);
