CREATE TYPE "public"."summary_regeneration_status" AS ENUM('idle', 'pending', 'processing', 'failed');--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "summary_regeneration_status" "summary_regeneration_status" DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "summary_regeneration_processing_started_at" timestamp with time zone;