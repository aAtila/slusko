CREATE TYPE "public"."summary_version_source" AS ENUM('initial', 'ai_revision', 'reset');--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "latest_summary_version_id" uuid;--> statement-breakpoint
CREATE TABLE "summary_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"source" "summary_version_source" NOT NULL,
	"source_revision_request_id" uuid,
	"source_summary_version_id" uuid,
	"overview" text DEFAULT '' NOT NULL,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "summary_versions_version_number_positive_check" CHECK ("summary_versions"."version_number" >= 1),
	CONSTRAINT "summary_versions_reset_source_summary_check" CHECK ("summary_versions"."source" <> 'reset' or "summary_versions"."source_summary_version_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "summary_versions" ADD CONSTRAINT "summary_versions_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_versions" ADD CONSTRAINT "summary_versions_source_summary_version_id_summary_versions_id_fk" FOREIGN KEY ("source_summary_version_id") REFERENCES "public"."summary_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "summary_versions_meeting_version_unique" ON "summary_versions" USING btree ("meeting_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "summary_versions_meeting_id_id_unique" ON "summary_versions" USING btree ("meeting_id","id");--> statement-breakpoint
CREATE INDEX "summary_versions_meeting_version_idx" ON "summary_versions" USING btree ("meeting_id","version_number" DESC NULLS LAST);--> statement-breakpoint
INSERT INTO "summary_versions" (
	"id",
	"meeting_id",
	"version_number",
	"source",
	"overview",
	"decisions",
	"action_items",
	"open_questions",
	"created_at",
	"updated_at"
)
SELECT
	gen_random_uuid(),
	"meeting_id",
	1,
	'initial',
	"overview",
	"decisions",
	"action_items",
	"open_questions",
	"created_at",
	"updated_at"
FROM "summaries";--> statement-breakpoint
UPDATE "meetings"
SET "latest_summary_version_id" = "summary_versions"."id"
FROM "summary_versions"
WHERE "summary_versions"."meeting_id" = "meetings"."id"
	AND "summary_versions"."version_number" = 1;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_latest_summary_version_same_meeting_fk" FOREIGN KEY ("id","latest_summary_version_id") REFERENCES "public"."summary_versions"("meeting_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP TABLE "summaries";