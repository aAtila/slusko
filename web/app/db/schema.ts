import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

export const meetingStatus = pgEnum("meeting_status", [
  "pending",
  "normalizing",
  "transcribing",
  "diarizing",
  "summarizing",
  "done",
  "error",
]);

export const summaryRegenerationStatus = pgEnum("summary_regeneration_status", [
  "idle",
  "pending",
  "processing",
  "failed",
]);

export const errorKind = pgEnum("error_kind", [
  "normalization_failed",
  "transcription_failed",
  "transcription_empty",
  "diarization_failed",
  "summarization_failed",
  "config_missing",
  "unknown",
]);

export const summaryVersionSource = pgEnum("summary_version_source", [
  "initial",
  "ai_revision",
  "reset",
]);

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    sourceFilenames: text("source_filenames").array().notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    language: text("language").$type<RequestedMeetingLanguage>(),
    detectedLanguage: text("detected_language"),
    status: meetingStatus("status").notNull().default("pending"),
    summaryRegenerationStatus: summaryRegenerationStatus(
      "summary_regeneration_status",
    )
      .notNull()
      .default("idle"),
    summaryRegenerationProcessingStartedAt: timestamp(
      "summary_regeneration_processing_started_at",
      { withTimezone: true },
    ),
    latestSummaryVersionId: uuid("latest_summary_version_id"),
    errorKind: errorKind("error_kind"),
    errorMessage: text("error_message"),
    failedAtStage: meetingStatus("failed_at_stage"),
    resumeFromStage: meetingStatus("resume_from_stage"),
    transcriptionProgress: integer("transcription_progress"),
    durationSeconds: integer("duration_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "meetings_transcription_progress_range_check",
      sql`${table.transcriptionProgress} is null or (${table.transcriptionProgress} >= 0 and ${table.transcriptionProgress} <= 100)`,
    ),
    check(
      "meetings_duration_seconds_non_negative_check",
      sql`${table.durationSeconds} is null or ${table.durationSeconds} >= 0`,
    ),
    check(
      "meetings_source_filenames_non_empty_check",
      sql`array_length(${table.sourceFilenames}, 1) >= 1`,
    ),
    check(
      "meetings_language_valid_check",
      sql`${table.language} is null or ${table.language} in ('sr', 'en')`,
    ),
    check(
      "meetings_detected_language_auto_only_check",
      sql`${table.detectedLanguage} is null or ${table.language} is null`,
    ),
    check(
      "meetings_detected_language_non_empty_check",
      sql`${table.detectedLanguage} is null or length(trim(${table.detectedLanguage})) > 0`,
    ),
    index("meetings_created_at_idx").on(table.createdAt.desc()),
    index("meetings_queue_claim_idx")
      .on(table.createdAt)
      .where(
        sql`${table.status} in ('pending', 'normalizing', 'transcribing', 'diarizing', 'summarizing')`,
      ),
    foreignKey({
      columns: [table.id, table.latestSummaryVersionId],
      foreignColumns: [
        summaryVersions.meetingId as AnyPgColumn,
        summaryVersions.id as AnyPgColumn,
      ],
      name: "meetings_latest_summary_version_same_meeting_fk",
    }),
  ],
);

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    startSeconds: doublePrecision("start_seconds").notNull(),
    endSeconds: doublePrecision("end_seconds").notNull(),
    speakerLabel: text("speaker_label").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("transcript_segments_meeting_start_idx").on(
      table.meetingId,
      table.startSeconds,
    ),
  ],
);

export type SummaryDecision = {
  text: string;
};

export type SummaryActionItemOwner =
  | { kind: "name"; value: string }
  | { kind: "speaker"; value: string }
  | { kind: "unknown" };

export type SummaryActionItem = {
  task: string;
  owner: SummaryActionItemOwner;
};

export type SummaryOpenQuestion = {
  text: string;
};

export const summaryVersions = pgTable(
  "summary_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references((): AnyPgColumn => meetings.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    source: summaryVersionSource("source").notNull(),
    sourceRevisionRequestId: uuid("source_revision_request_id"),
    sourceSummaryVersionId: uuid("source_summary_version_id").references(
      (): AnyPgColumn => summaryVersions.id,
    ),
    overview: text("overview").notNull().default(""),
    decisions: jsonb("decisions")
      .$type<SummaryDecision[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    actionItems: jsonb("action_items")
      .$type<SummaryActionItem[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    openQuestions: jsonb("open_questions")
      .$type<SummaryOpenQuestion[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("summary_versions_meeting_version_unique").on(
      table.meetingId,
      table.versionNumber,
    ),
    uniqueIndex("summary_versions_meeting_id_id_unique").on(
      table.meetingId,
      table.id,
    ),
    index("summary_versions_meeting_version_idx").on(
      table.meetingId,
      table.versionNumber.desc(),
    ),
    check(
      "summary_versions_version_number_positive_check",
      sql`${table.versionNumber} >= 1`,
    ),
    check(
      "summary_versions_reset_source_summary_check",
      sql`${table.source} <> 'reset' or ${table.sourceSummaryVersionId} is not null`,
    ),
  ],
);

export const speakerMappings = pgTable(
  "speaker_mappings",
  {
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    speakerLabel: text("speaker_label").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.meetingId, table.speakerLabel],
      name: "speaker_mappings_pkey",
    }),
  ],
);

export type RequestedMeetingLanguage = "sr" | "en";
export type MeetingLanguage = RequestedMeetingLanguage | null;
export type MeetingStatus = (typeof meetingStatus.enumValues)[number];
export type SummaryRegenerationStatus =
  (typeof summaryRegenerationStatus.enumValues)[number];
export type SummaryVersionSource =
  (typeof summaryVersionSource.enumValues)[number];
export type ErrorKind = (typeof errorKind.enumValues)[number];
export type Meeting = typeof meetings.$inferSelect;
