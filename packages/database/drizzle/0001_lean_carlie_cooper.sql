CREATE TABLE "document_extracted_texts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"file_object_id" uuid NOT NULL,
	"extractor_kind" varchar(32) NOT NULL,
	"language_config" varchar(32) DEFAULT 'portuguese' NOT NULL,
	"char_count" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"extracted_text" text NOT NULL,
	"search_vector" "tsvector" NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_extracted_texts_char_non_neg_chk" CHECK ("document_extracted_texts"."char_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_extracted_texts" ADD CONSTRAINT "document_extracted_texts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extracted_texts" ADD CONSTRAINT "document_extracted_texts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extracted_texts" ADD CONSTRAINT "document_extracted_texts_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extracted_texts" ADD CONSTRAINT "document_extracted_texts_file_object_id_file_objects_id_fk" FOREIGN KEY ("file_object_id") REFERENCES "public"."file_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_extracted_texts_version_unique" ON "document_extracted_texts" USING btree ("document_version_id");--> statement-breakpoint
CREATE INDEX "document_extracted_texts_org_doc_idx" ON "document_extracted_texts" USING btree ("organization_id","document_id");--> statement-breakpoint
CREATE INDEX "document_extracted_texts_search_gin_idx" ON "document_extracted_texts" USING gin ("search_vector");