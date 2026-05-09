import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
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

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    sourceFilenames: text("source_filenames").array().notNull(),
    uploadedBy: text("uploaded_by").notNull(),
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
  (table) => [
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
    index("meetings_created_at_idx").on(table.createdAt.desc()),
    index("meetings_queue_claim_idx")
      .on(table.createdAt)
      .where(
        sql`${table.status} in ('pending', 'normalizing', 'transcribing', 'diarizing', 'summarizing')`,
      ),
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

export const summaries = pgTable("summaries", {
  meetingId: uuid("meeting_id")
    .primaryKey()
    .references(() => meetings.id, { onDelete: "cascade" }),
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
});

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

export type MeetingStatus = (typeof meetingStatus.enumValues)[number];
export type SummaryRegenerationStatus =
  (typeof summaryRegenerationStatus.enumValues)[number];
export type ErrorKind = (typeof errorKind.enumValues)[number];
export type Meeting = typeof meetings.$inferSelect;
