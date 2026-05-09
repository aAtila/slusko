ALTER TABLE "meetings" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "detected_language" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_language_valid_check" CHECK ("meetings"."language" is null or "meetings"."language" in ('sr', 'en'));--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_detected_language_auto_only_check" CHECK ("meetings"."detected_language" is null or "meetings"."language" is null);--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_detected_language_non_empty_check" CHECK ("meetings"."detected_language" is null or length(trim("meetings"."detected_language")) > 0);