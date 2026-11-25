CREATE TABLE "document_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"label" varchar(120),
	"allow_download" boolean DEFAULT true NOT NULL,
	"passcode_hash" text,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"last_accessed_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_share_links_use_count_chk" CHECK ("document_share_links"."use_count" >= 0),
	CONSTRAINT "document_share_links_max_uses_chk" CHECK ("document_share_links"."max_uses" IS NULL OR "document_share_links"."max_uses" >= 1)
);
--> statement-breakpoint
ALTER TABLE "document_share_links" ADD CONSTRAINT "document_share_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_share_links" ADD CONSTRAINT "document_share_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_share_links" ADD CONSTRAINT "document_share_links_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_share_links" ADD CONSTRAINT "document_share_links_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_share_links" ADD CONSTRAINT "document_share_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_share_links_token_hash_unique" ON "document_share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "document_share_links_org_doc_created_idx" ON "document_share_links" USING btree ("organization_id","document_id","created_at");--> statement-breakpoint
CREATE INDEX "document_share_links_expires_idx" ON "document_share_links" USING btree ("expires_at");