CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."error_kind" AS ENUM('normalization_failed', 'transcription_failed', 'transcription_empty', 'diarization_failed', 'summarization_failed', 'config_missing', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('pending', 'normalizing', 'transcribing', 'diarizing', 'summarizing', 'done', 'error');--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"source_filenames" text[] NOT NULL,
	"uploaded_by" text NOT NULL,
	"status" "meeting_status" DEFAULT 'pending' NOT NULL,
	"error_kind" "error_kind",
	"error_message" text,
	"failed_at_stage" "meeting_status",
	"resume_from_stage" "meeting_status",
	"transcription_progress" integer,
	"duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_transcription_progress_range_check" CHECK ("transcription_progress" IS NULL OR ("transcription_progress" >= 0 AND "transcription_progress" <= 100)),
	CONSTRAINT "meetings_duration_seconds_non_negative_check" CHECK ("duration_seconds" IS NULL OR "duration_seconds" >= 0),
	CONSTRAINT "meetings_source_filenames_non_empty_check" CHECK (array_length("source_filenames", 1) >= 1)
);
--> statement-breakpoint
CREATE TABLE "speaker_mappings" (
	"meeting_id" uuid NOT NULL,
	"speaker_label" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "speaker_mappings_pkey" PRIMARY KEY("meeting_id","speaker_label")
);
--> statement-breakpoint
CREATE TABLE "summaries" (
	"meeting_id" uuid PRIMARY KEY NOT NULL,
	"overview" text DEFAULT '' NOT NULL,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"start_seconds" double precision NOT NULL,
	"end_seconds" double precision NOT NULL,
	"speaker_label" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "speaker_mappings" ADD CONSTRAINT "speaker_mappings_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetings_created_at_idx" ON "meetings" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "meetings_queue_claim_idx" ON "meetings" USING btree ("created_at") WHERE "meetings"."status" in ('pending', 'normalizing', 'transcribing', 'diarizing', 'summarizing');--> statement-breakpoint
CREATE INDEX "transcript_segments_meeting_start_idx" ON "transcript_segments" USING btree ("meeting_id","start_seconds");