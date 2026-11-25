CREATE TYPE "public"."category_text_indexing_mode" AS ENUM('NEVER', 'ALWAYS', 'ASK');--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "index_content_requested" boolean;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "text_indexing_mode" "category_text_indexing_mode" DEFAULT 'NEVER' NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;