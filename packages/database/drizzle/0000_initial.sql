CREATE TYPE "public"."document_status" AS ENUM('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED', 'EXPIRED', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('SUCCESS', 'DENIED', 'FAILURE');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."retention_action" AS ENUM('ARCHIVE', 'TRASH', 'PURGE');--> statement-breakpoint
CREATE TYPE "public"."access_action" AS ENUM('READ', 'CREATE', 'UPDATE', 'DELETE', 'UPLOAD', 'DOWNLOAD', 'APPROVE', 'REJECT', 'MANAGE_PERMISSIONS', 'MANAGE_STORAGE', 'MANAGE_USERS', 'VIEW_AUDIT');--> statement-breakpoint
CREATE TYPE "public"."access_effect" AS ENUM('ALLOW', 'DENY');--> statement-breakpoint
CREATE TYPE "public"."access_resource" AS ENUM('DOCUMENT', 'FOLDER', 'CATEGORY', 'WORKFLOW', 'USER', 'GROUP', 'ROLE', 'STORAGE', 'AUDIT', 'ORGANIZATION');--> statement-breakpoint
CREATE TYPE "public"."access_scope_type" AS ENUM('GLOBAL', 'CATEGORY', 'FOLDER', 'DOCUMENT');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'INACTIVE', 'LOCKED');--> statement-breakpoint
CREATE TYPE "public"."file_object_status" AS ENUM('UPLOADING', 'QUARANTINED', 'AVAILABLE', 'REJECTED', 'MISSING', 'DELETE_PENDING');--> statement-breakpoint
CREATE TYPE "public"."storage_connection_kind" AS ENUM('local', 's3', 'azure_blob', 'google_cloud');--> statement-breakpoint
CREATE TYPE "public"."storage_connection_status" AS ENUM('ACTIVE', 'INACTIVE', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."storage_operation_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."storage_operation_type" AS ENUM('COPY', 'DELETE', 'VERIFY_CHECKSUM');--> statement-breakpoint
CREATE TYPE "public"."upload_session_status" AS ENUM('PENDING', 'UPLOADED', 'FINALIZED', 'EXPIRED', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."category_field_type" AS ENUM('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SINGLE_SELECT', 'MULTI_SELECT');--> statement-breakpoint
CREATE TYPE "public"."folder_status" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('INTERNAL', 'EMAIL');--> statement-breakpoint
CREATE TYPE "public"."workflow_assignee_type" AS ENUM('USER', 'GROUP', 'ROLE');--> statement-breakpoint
CREATE TYPE "public"."workflow_decision_type" AS ENUM('APPROVE', 'REJECT', 'REQUEST_CHANGES');--> statement-breakpoint
CREATE TYPE "public"."workflow_instance_status" AS ENUM('ACTIVE', 'COMPLETED', 'REJECTED', 'CHANGES_REQUESTED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."workflow_task_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "document_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"field_key" varchar(64) NOT NULL,
	"value_text" text,
	"value_number" double precision,
	"value_date" date,
	"value_boolean" boolean,
	"value_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"file_object_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"change_note" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_number_positive_chk" CHECK ("document_versions"."version_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"category_id" uuid NOT NULL,
	"folder_id" uuid,
	"status" "document_status" DEFAULT 'DRAFT' NOT NULL,
	"current_version_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"issue_date" date,
	"expiration_date" date,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_version_positive_chk" CHECK ("documents"."version" >= 1),
	CONSTRAINT "documents_expiration_after_issue_chk" CHECK ("documents"."expiration_date" IS NULL OR "documents"."issue_date" IS NULL OR "documents"."expiration_date" >= "documents"."issue_date")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"action" varchar(120) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" uuid,
	"result" "audit_result" NOT NULL,
	"request_id" uuid NOT NULL,
	"ip_address" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_retention_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"placed_by_user_id" uuid NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by_user_id" uuid,
	"released_at" timestamp with time zone,
	"release_reason" varchar(500),
	CONSTRAINT "document_retention_holds_release_after_place_chk" CHECK ("document_retention_holds"."released_at" IS NULL OR "document_retention_holds"."released_at" >= "document_retention_holds"."placed_at")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"aggregate_type" varchar(64) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"last_error" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_attempts_non_neg_chk" CHECK ("outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid,
	"name" varchar(120) NOT NULL,
	"retention_days" integer NOT NULL,
	"trash_grace_days" integer DEFAULT 30 NOT NULL,
	"action_on_expiry" "retention_action" DEFAULT 'TRASH' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_days_pos_chk" CHECK ("retention_policies"."retention_days" >= 1),
	CONSTRAINT "retention_policies_grace_pos_chk" CHECK ("retention_policies"."trash_grace_days" >= 1)
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(500),
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"default_language" varchar(16) DEFAULT 'pt-BR' NOT NULL,
	"timezone" varchar(64) DEFAULT 'America/Sao_Paulo' NOT NULL,
	"logo_object_key" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "access_action" NOT NULL,
	"resource" "access_resource" NOT NULL,
	"description" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(500),
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_address" varchar(64),
	"user_agent" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_expires_after_created_chk" CHECK ("sessions"."expires_at" > "sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_role_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"group_id" uuid,
	"role_id" uuid NOT NULL,
	"scope_type" "access_scope_type" NOT NULL,
	"scope_target_id" uuid,
	"effect" "access_effect" DEFAULT 'ALLOW' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_scopes_subject_chk" CHECK (("user_role_scopes"."user_id" IS NOT NULL AND "user_role_scopes"."group_id" IS NULL) OR ("user_role_scopes"."user_id" IS NULL AND "user_role_scopes"."group_id" IS NOT NULL)),
	CONSTRAINT "user_role_scopes_target_chk" CHECK (("user_role_scopes"."scope_type" = 'GLOBAL' AND "user_role_scopes"."scope_target_id" IS NULL) OR ("user_role_scopes"."scope_type" <> 'GLOBAL' AND "user_role_scopes"."scope_target_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"full_name" varchar(160) NOT NULL,
	"password_hash" text NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase_chk" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
CREATE TABLE "file_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"storage_connection_id" uuid NOT NULL,
	"object_key" varchar(512) NOT NULL,
	"original_file_name" varchar(255) NOT NULL,
	"detected_content_type" varchar(255) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"status" "file_object_status" DEFAULT 'UPLOADING' NOT NULL,
	"rejection_reason" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_objects_size_non_neg_chk" CHECK ("file_objects"."size_bytes" >= 0),
	CONSTRAINT "file_objects_sha256_hex_chk" CHECK ("file_objects"."checksum_sha256" ~ '^[0-9a-fA-F]{64}$')
);
--> statement-breakpoint
CREATE TABLE "storage_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"kind" "storage_connection_kind" NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "storage_connection_status" DEFAULT 'ACTIVE' NOT NULL,
	"non_secret_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_secret_payload" text,
	"last_health_check_at" timestamp with time zone,
	"last_health_message" varchar(500),
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"file_object_id" uuid NOT NULL,
	"storage_connection_id" uuid NOT NULL,
	"operation_type" "storage_operation_type" NOT NULL,
	"status" "storage_operation_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" varchar(500),
	"next_attempt_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_operations_attempts_non_neg_chk" CHECK ("storage_operations"."attempts" >= 0),
	CONSTRAINT "storage_operations_max_attempts_pos_chk" CHECK ("storage_operations"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE TABLE "storage_routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid,
	"storage_connection_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_connection_id" uuid NOT NULL,
	"file_object_id" uuid NOT NULL,
	"declared_size_bytes" bigint NOT NULL,
	"declared_content_type" varchar(255) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"status" "upload_session_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_sessions_size_positive_chk" CHECK ("upload_sessions"."declared_size_bytes" > 0),
	CONSTRAINT "upload_sessions_expires_after_created_chk" CHECK ("upload_sessions"."expires_at" > "upload_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(500),
	"color" varchar(7),
	"icon" varchar(64),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"label" varchar(120) NOT NULL,
	"type" "category_field_type" NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_fields_sort_order_non_neg_chk" CHECK ("category_fields"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" varchar(120) NOT NULL,
	"materialized_path" text NOT NULL,
	"status" "folder_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_no_self_parent_chk" CHECK ("folders"."parent_id" IS NULL OR "folders"."parent_id" <> "folders"."id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"normalized_name" varchar(64) NOT NULL,
	"color" varchar(7),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_normalized_lowercase_chk" CHECK ("tags"."normalized_name" = lower("tags"."normalized_name"))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"channel" "notification_channel" DEFAULT 'INTERNAL' NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"resource_type" varchar(64),
	"resource_id" uuid,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"decision" "workflow_decision_type" NOT NULL,
	"comment" varchar(2000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_decisions_comment_required_chk" CHECK ("workflow_decisions"."decision" = 'APPROVE' OR ("workflow_decisions"."comment" IS NOT NULL AND length(btrim("workflow_decisions"."comment")) > 0))
);
--> statement-breakpoint
CREATE TABLE "workflow_definition_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_definition_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"steps" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_def_versions_num_pos_chk" CHECK ("workflow_definition_versions"."version_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(500),
	"is_active" boolean DEFAULT true NOT NULL,
	"latest_version_number" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_definitions_version_non_neg_chk" CHECK ("workflow_definitions"."latest_version_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workflow_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"workflow_definition_version_id" uuid NOT NULL,
	"status" "workflow_instance_status" DEFAULT 'ACTIVE' NOT NULL,
	"current_step_order" integer DEFAULT 1 NOT NULL,
	"started_by_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workflow_instances_step_pos_chk" CHECK ("workflow_instances"."current_step_order" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workflow_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workflow_instance_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"step_order" integer NOT NULL,
	"status" "workflow_task_status" DEFAULT 'PENDING' NOT NULL,
	"assignee_type" "workflow_assignee_type" NOT NULL,
	"assignee_target_id" uuid NOT NULL,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "workflow_tasks_step_pos_chk" CHECK ("workflow_tasks"."step_order" >= 1)
);
--> statement-breakpoint
ALTER TABLE "document_metadata" ADD CONSTRAINT "document_metadata_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_metadata" ADD CONSTRAINT "document_metadata_field_id_category_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."category_fields"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_file_object_id_file_objects_id_fk" FOREIGN KEY ("file_object_id") REFERENCES "public"."file_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_id_document_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_retention_holds" ADD CONSTRAINT "document_retention_holds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_retention_holds" ADD CONSTRAINT "document_retention_holds_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_retention_holds" ADD CONSTRAINT "document_retention_holds_placed_by_user_id_users_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_retention_holds" ADD CONSTRAINT "document_retention_holds_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_scopes" ADD CONSTRAINT "user_role_scopes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_scopes" ADD CONSTRAINT "user_role_scopes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_scopes" ADD CONSTRAINT "user_role_scopes_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_scopes" ADD CONSTRAINT "user_role_scopes_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_scopes" ADD CONSTRAINT "user_role_scopes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_storage_connection_id_storage_connections_id_fk" FOREIGN KEY ("storage_connection_id") REFERENCES "public"."storage_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_connections" ADD CONSTRAINT "storage_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_connections" ADD CONSTRAINT "storage_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_connections" ADD CONSTRAINT "storage_connections_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_operations" ADD CONSTRAINT "storage_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_operations" ADD CONSTRAINT "storage_operations_file_object_id_file_objects_id_fk" FOREIGN KEY ("file_object_id") REFERENCES "public"."file_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_operations" ADD CONSTRAINT "storage_operations_storage_connection_id_storage_connections_id_fk" FOREIGN KEY ("storage_connection_id") REFERENCES "public"."storage_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_routing_rules" ADD CONSTRAINT "storage_routing_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_routing_rules" ADD CONSTRAINT "storage_routing_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_routing_rules" ADD CONSTRAINT "storage_routing_rules_storage_connection_id_storage_connections_id_fk" FOREIGN KEY ("storage_connection_id") REFERENCES "public"."storage_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_routing_rules" ADD CONSTRAINT "storage_routing_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_routing_rules" ADD CONSTRAINT "storage_routing_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_storage_connection_id_storage_connections_id_fk" FOREIGN KEY ("storage_connection_id") REFERENCES "public"."storage_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_file_object_id_file_objects_id_fk" FOREIGN KEY ("file_object_id") REFERENCES "public"."file_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_fields" ADD CONSTRAINT "category_fields_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_decisions" ADD CONSTRAINT "workflow_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_decisions" ADD CONSTRAINT "workflow_decisions_task_id_workflow_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."workflow_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_decisions" ADD CONSTRAINT "workflow_decisions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definition_versions" ADD CONSTRAINT "workflow_definition_versions_workflow_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definition_versions" ADD CONSTRAINT "workflow_definition_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_workflow_definition_version_id_workflow_definition_versions_id_fk" FOREIGN KEY ("workflow_definition_version_id") REFERENCES "public"."workflow_definition_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_tasks" ADD CONSTRAINT "workflow_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_tasks" ADD CONSTRAINT "workflow_tasks_workflow_instance_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_tasks" ADD CONSTRAINT "workflow_tasks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_tasks" ADD CONSTRAINT "workflow_tasks_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_metadata_doc_field_unique" ON "document_metadata" USING btree ("document_id","field_id");--> statement-breakpoint
CREATE INDEX "document_metadata_field_text_idx" ON "document_metadata" USING btree ("field_id","value_text");--> statement-breakpoint
CREATE INDEX "document_metadata_field_date_idx" ON "document_metadata" USING btree ("field_id","value_date");--> statement-breakpoint
CREATE INDEX "document_metadata_field_number_idx" ON "document_metadata" USING btree ("field_id","value_number");--> statement-breakpoint
CREATE UNIQUE INDEX "document_tags_doc_tag_unique" ON "document_tags" USING btree ("document_id","tag_id");--> statement-breakpoint
CREATE INDEX "document_tags_tag_idx" ON "document_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_doc_number_unique" ON "document_versions" USING btree ("document_id","version_number");--> statement-breakpoint
CREATE INDEX "document_versions_file_obj_idx" ON "document_versions" USING btree ("file_object_id");--> statement-breakpoint
CREATE INDEX "document_versions_uploaded_by_idx" ON "document_versions" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "documents_org_status_updated_idx" ON "documents" USING btree ("organization_id","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "documents_org_cat_status_idx" ON "documents" USING btree ("organization_id","category_id","status");--> statement-breakpoint
CREATE INDEX "documents_org_folder_status_idx" ON "documents" USING btree ("organization_id","folder_id","status");--> statement-breakpoint
CREATE INDEX "documents_org_owner_idx" ON "documents" USING btree ("organization_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "documents_org_expiration_idx" ON "documents" USING btree ("organization_id","expiration_date");--> statement-breakpoint
CREATE INDEX "documents_org_title_idx" ON "documents" USING btree ("organization_id","title");--> statement-breakpoint
CREATE INDEX "audit_events_org_occurred_idx" ON "audit_events" USING btree ("organization_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "audit_events_org_actor_idx" ON "audit_events" USING btree ("organization_id","actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_resource_idx" ON "audit_events" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "document_retention_holds_doc_released_idx" ON "document_retention_holds" USING btree ("document_id","released_at");--> statement-breakpoint
CREATE INDEX "outbox_events_status_available_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_policies_org_name_unique" ON "retention_policies" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_org_name_unique" ON "groups" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_action_resource_unique" ON "permissions" USING btree ("action","resource");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_role_perm_unique" ON "role_permissions" USING btree ("role_id","permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_org_key_unique" ON "roles" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_groups_user_group_unique" ON "user_groups" USING btree ("user_id","group_id");--> statement-breakpoint
CREATE INDEX "user_groups_group_idx" ON "user_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "user_role_scopes_org_user_idx" ON "user_role_scopes" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "user_role_scopes_org_group_idx" ON "user_role_scopes" USING btree ("organization_id","group_id");--> statement-breakpoint
CREATE INDEX "user_role_scopes_scope_idx" ON "user_role_scopes" USING btree ("scope_type","scope_target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_unique" ON "users" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "users_org_status_idx" ON "users" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "users_org_created_idx" ON "users" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "file_objects_conn_key_unique" ON "file_objects" USING btree ("storage_connection_id","object_key");--> statement-breakpoint
CREATE INDEX "file_objects_org_status_idx" ON "file_objects" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "file_objects_conn_idx" ON "file_objects" USING btree ("storage_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_connections_org_name_unique" ON "storage_connections" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_connections_org_default_unique" ON "storage_connections" USING btree ("organization_id") WHERE "storage_connections"."is_default" = true;--> statement-breakpoint
CREATE INDEX "storage_connections_org_status_idx" ON "storage_connections" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "storage_operations_status_next_idx" ON "storage_operations" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "storage_operations_file_obj_idx" ON "storage_operations" USING btree ("file_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_routing_rules_org_cat_unique" ON "storage_routing_rules" USING btree ("organization_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_routing_rules_org_default_unique" ON "storage_routing_rules" USING btree ("organization_id") WHERE "storage_routing_rules"."category_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_idempotency_unique" ON "upload_sessions" USING btree ("organization_id","user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "upload_sessions_org_status_exp_idx" ON "upload_sessions" USING btree ("organization_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "upload_sessions_file_obj_idx" ON "upload_sessions" USING btree ("file_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_org_name_unique" ON "categories" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "categories_org_active_idx" ON "categories" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "category_fields_cat_key_unique" ON "category_fields" USING btree ("category_id","key");--> statement-breakpoint
CREATE INDEX "category_fields_cat_order_idx" ON "category_fields" USING btree ("category_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_org_parent_name_unique" ON "folders" USING btree ("organization_id","parent_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_org_root_name_unique" ON "folders" USING btree ("organization_id","name") WHERE "folders"."parent_id" IS NULL;--> statement-breakpoint
CREATE INDEX "folders_org_parent_status_idx" ON "folders" USING btree ("organization_id","parent_id","status");--> statement-breakpoint
CREATE INDEX "folders_org_path_idx" ON "folders" USING btree ("organization_id","materialized_path");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_org_normalized_name_unique" ON "tags" USING btree ("organization_id","normalized_name");--> statement-breakpoint
CREATE INDEX "notifications_recipient_read_created_idx" ON "notifications" USING btree ("recipient_user_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_decisions_task_unique" ON "workflow_decisions" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_def_versions_def_num_unique" ON "workflow_definition_versions" USING btree ("workflow_definition_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_org_name_unique" ON "workflow_definitions" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "workflow_instances_doc_status_idx" ON "workflow_instances" USING btree ("document_id","status");--> statement-breakpoint
CREATE INDEX "workflow_instances_doc_version_idx" ON "workflow_instances" USING btree ("document_version_id");--> statement-breakpoint
CREATE INDEX "workflow_instances_org_status_idx" ON "workflow_instances" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_tasks_instance_step_unique" ON "workflow_tasks" USING btree ("workflow_instance_id","step_order");--> statement-breakpoint
CREATE INDEX "workflow_tasks_org_status_due_idx" ON "workflow_tasks" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE INDEX "workflow_tasks_assignee_status_idx" ON "workflow_tasks" USING btree ("assignee_type","assignee_target_id","status");--> statement-breakpoint
CREATE INDEX "workflow_tasks_doc_idx" ON "workflow_tasks" USING btree ("document_id");