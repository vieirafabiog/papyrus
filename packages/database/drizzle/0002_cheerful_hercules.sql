ALTER TABLE "notifications" ADD COLUMN "kind" varchar(64) DEFAULT 'TASK_ASSIGNED' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "idempotency_key" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_org_channel_recipient_idem_unique" ON "notifications" USING btree ("organization_id","channel","recipient_user_id","idempotency_key");