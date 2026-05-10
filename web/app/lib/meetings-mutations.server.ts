import { and, sql as drizzleSql, eq } from "drizzle-orm";
import {
  meetings,
  speakerMappings,
  transcriptSegments,
  type ErrorKind,
  type MeetingStatus,
  type SummaryRegenerationStatus,
} from "~/db/schema";
import { isMeetingId } from "./meeting-id";
import {
  meetingLanguageValidationMessage,
  parseMeetingLanguageFormValue,
  type MeetingLanguage,
} from "./meeting-language";
import { removeMeetingDirectory as removeMeetingStorageDirectory } from "./meeting-storage.server";
import {
  getMeetingFailurePresentation,
  isRetryableFailedStage,
} from "./meetings-list";

const maxMeetingTitleLength = 200;
const maxSpeakerNameLength = 100;
const speakerLabelPattern = /^SPEAKER_\d+$/;

export class MeetingMutationError extends Error {
  readonly status: 400 | 404;

  constructor(message: string, status: 400 | 404) {
    super(message);
    this.name = "MeetingMutationError";
    this.status = status;
  }
}

export type UpdateMeetingTitleResult = {
  id: string;
  title: string;
};

export type DeleteMeetingResult = {
  id: string;
};

export type SaveSpeakerMappingResult = {
  meetingId: string;
  speakerLabel: string;
  name: string | null;
};

export type RetryMeetingResult = {
  id: string;
  resumeFromStage: MeetingStatus;
};

export type UpdateMeetingLanguageResult = {
  id: string;
  language: MeetingLanguage;
};

export type RegenerateSummaryResult = {
  id: string;
};

type MeetingFailureRow = {
  id: string;
  status: MeetingStatus;
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  failedAtStage: MeetingStatus | null;
  language: MeetingLanguage;
  detectedLanguage: string | null;
};

type RetryMeetingUpdate = {
  status: "pending";
  errorKind: null;
  errorMessage: null;
  failedAtStage: null;
  resumeFromStage: MeetingStatus;
  transcriptionProgress: null;
  language: MeetingLanguage;
  clearDetectedLanguage: boolean;
};

type DeleteMeetingOptions = {
  findMeetingById?: (meetingId: string) => Promise<{ id: string } | null>;
  removeMeetingDirectory?: (meetingId: string) => Promise<void>;
  deleteMeetingById?: (meetingId: string) => Promise<boolean>;
};

type UpdateMeetingTitleOptions = {
  updateMeetingTitleById?: (
    meetingId: string,
    title: string,
  ) => Promise<UpdateMeetingTitleResult | null>;
};

type MeetingStatusRow = {
  id: string;
  status: MeetingStatus;
  language: MeetingLanguage;
  resumeFromStage: MeetingStatus | null;
};

type UpdateMeetingLanguagePersistence = {
  language: MeetingLanguage;
  resumeFromStage: MeetingStatus | null;
  clearDetectedLanguage: boolean;
};

type UpdateMeetingLanguageOptions = {
  findMeetingStatusById?: (
    meetingId: string,
  ) => Promise<MeetingStatusRow | null>;
  updateMeetingLanguageById?: (
    meetingId: string,
    update: UpdateMeetingLanguagePersistence,
  ) => Promise<UpdateMeetingLanguageResult | null>;
};

type SaveSpeakerMappingOptions = {
  findMeetingById?: (meetingId: string) => Promise<{ id: string } | null>;
  speakerLabelExistsForMeeting?: (
    meetingId: string,
    speakerLabel: string,
  ) => Promise<boolean>;
  upsertSpeakerMapping?: (
    meetingId: string,
    speakerLabel: string,
    name: string,
  ) => Promise<SaveSpeakerMappingResult>;
  deleteSpeakerMapping?: (
    meetingId: string,
    speakerLabel: string,
  ) => Promise<void>;
};

type RetryMeetingOptions = {
  findMeetingFailureById?: (
    meetingId: string,
  ) => Promise<MeetingFailureRow | null>;
  retryMeetingById?: (
    meetingId: string,
    update: RetryMeetingUpdate,
  ) => Promise<RetryMeetingResult | null>;
};

type MeetingSummaryRegenerationRow = {
  id: string;
  status: MeetingStatus;
  summaryRegenerationStatus: SummaryRegenerationStatus;
  latestSummaryVersionId: string | null;
};

type RegenerateSummaryOptions = {
  findMeetingSummaryRegenerationById?: (
    meetingId: string,
  ) => Promise<MeetingSummaryRegenerationRow | null>;
  queueSummaryRegenerationById?: (
    meetingId: string,
  ) => Promise<RegenerateSummaryResult | null>;
};

export async function deleteMeetingAndArtifacts(
  input: { meetingId: string | undefined },
  options: DeleteMeetingOptions = {},
): Promise<DeleteMeetingResult> {
  if (!isMeetingId(input.meetingId)) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  const meeting = await (options.findMeetingById ?? findMeetingById)(
    input.meetingId,
  );

  if (meeting === null) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  await (options.removeMeetingDirectory ?? removeStoredMeetingDirectory)(
    input.meetingId,
  );
  await (options.deleteMeetingById ?? deleteMeetingById)(input.meetingId);

  return { id: input.meetingId };
}

export async function saveSpeakerMapping(
  input: {
    meetingId: string | undefined;
    speakerLabel: unknown;
    name: unknown;
  },
  options: SaveSpeakerMappingOptions = {},
): Promise<SaveSpeakerMappingResult> {
  if (!isMeetingId(input.meetingId)) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  const speakerLabel = validateSpeakerLabel(input.speakerLabel);
  const name = validateSpeakerName(input.name);
  const meeting = await (options.findMeetingById ?? findMeetingById)(
    input.meetingId,
  );

  if (meeting === null) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  const isDiscoveredSpeakerLabel = await (
    options.speakerLabelExistsForMeeting ?? speakerLabelExistsForMeeting
  )(input.meetingId, speakerLabel);

  if (!isDiscoveredSpeakerLabel) {
    throw new MeetingMutationError("Choose a discovered speaker label.", 400);
  }

  if (name.length === 0) {
    await (options.deleteSpeakerMapping ?? deleteSpeakerMapping)(
      input.meetingId,
      speakerLabel,
    );

    return { meetingId: input.meetingId, speakerLabel, name: null };
  }

  return (options.upsertSpeakerMapping ?? upsertSpeakerMapping)(
    input.meetingId,
    speakerLabel,
    name,
  );
}

export async function updateMeetingTitle(
  input: { meetingId: string | undefined; title: unknown },
  options: UpdateMeetingTitleOptions = {},
): Promise<UpdateMeetingTitleResult> {
  if (!isMeetingId(input.meetingId)) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  const title = validateMeetingTitle(input.title);
  const result = await (options.updateMeetingTitleById ?? updateTitleById)(
    input.meetingId,
    title,
  );

  if (result === null) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  return result;
}

export async function updateMeetingLanguage(
  input: { meetingId: string | undefined; language: unknown },
  options: UpdateMeetingLanguageOptions = {},
): Promise<UpdateMeetingLanguageResult> {
  if (!isMeetingId(input.meetingId)) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  if (
    input.language === undefined ||
    input.language === null ||
    input.language === ""
  ) {
    throw new MeetingMutationError(meetingLanguageValidationMessage, 400);
  }

  const parsedLanguage = parseMeetingLanguageFormValue(input.language);

  if (!parsedLanguage.ok) {
    throw new MeetingMutationError(parsedLanguage.error, 400);
  }

  const findStatus = options.findMeetingStatusById ?? findMeetingStatusById;
  const meeting = await findStatus(input.meetingId);

  if (meeting === null) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  assertCanUpdateMeetingLanguage(meeting);

  const result = await (
    options.updateMeetingLanguageById ?? updateLanguageById
  )(meeting.id, createPendingLanguageUpdate(meeting, parsedLanguage.language));

  if (result === null) {
    const currentMeeting = await findStatus(input.meetingId);

    if (currentMeeting === null) {
      throw new MeetingMutationError("Meeting not found", 404);
    }

    assertCanUpdateMeetingLanguage(currentMeeting);

    throw new MeetingMutationError(
      "Could not update language. Please try again.",
      400,
    );
  }

  return result;
}

export async function regenerateSummary(
  input: { meetingId: string | undefined },
  options: RegenerateSummaryOptions = {},
): Promise<RegenerateSummaryResult> {
  if (!isMeetingId(input.meetingId)) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  const meeting = await (
    options.findMeetingSummaryRegenerationById ??
    findMeetingSummaryRegenerationById
  )(input.meetingId);

  if (meeting === null) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  assertCanRegenerateSummary(meeting);

  const result = await (
    options.queueSummaryRegenerationById ?? queueSummaryRegenerationById
  )(meeting.id);

  if (result === null) {
    const currentMeeting = await (
      options.findMeetingSummaryRegenerationById ??
      findMeetingSummaryRegenerationById
    )(input.meetingId);

    if (currentMeeting === null) {
      throw new MeetingMutationError("Meeting not found", 404);
    }

    assertCanRegenerateSummary(currentMeeting);

    throw new MeetingMutationError(
      "Could not queue summary regeneration. Please try again.",
      400,
    );
  }

  return result;
}

export async function retryMeeting(
  input: { meetingId: string | undefined; language?: unknown },
  options: RetryMeetingOptions = {},
): Promise<RetryMeetingResult> {
  if (!isMeetingId(input.meetingId)) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  const meeting = await (
    options.findMeetingFailureById ?? findMeetingFailureById
  )(input.meetingId);

  if (meeting === null) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  if (meeting.status !== "error") {
    throw new MeetingMutationError("Only failed meetings can be retried.", 400);
  }

  const presentation = getMeetingFailurePresentation(meeting);

  if (presentation === null) {
    throw new MeetingMutationError("Only failed meetings can be retried.", 400);
  }

  if (
    !presentation.isRetryable ||
    !isRetryableFailedStage(meeting.failedAtStage)
  ) {
    throw new MeetingMutationError(
      presentation.retryUnavailableReason ?? "This failure cannot be retried.",
      400,
    );
  }

  const parsedLanguage = parseMeetingLanguageFormValue(input.language, {
    defaultWhenMissing: meeting.language,
  });

  if (!parsedLanguage.ok) {
    throw new MeetingMutationError(parsedLanguage.error, 400);
  }

  const result = await (options.retryMeetingById ?? retryMeetingById)(
    meeting.id,
    createRetryMeetingUpdate(meeting, parsedLanguage.language),
  );

  if (result === null) {
    throw new MeetingMutationError("Meeting not found", 404);
  }

  return result;
}

function assertCanUpdateMeetingLanguage(meeting: MeetingStatusRow) {
  if (meeting.status !== "pending") {
    throw new MeetingMutationError(
      "Language can only be changed while the meeting is pending.",
      400,
    );
  }
}

function createPendingLanguageUpdate(
  meeting: MeetingStatusRow,
  selectedLanguage: MeetingLanguage,
): UpdateMeetingLanguagePersistence {
  const languageChanged = selectedLanguage !== meeting.language;
  const shouldReTranscribeQueuedRetry =
    languageChanged &&
    (meeting.resumeFromStage === "diarizing" ||
      meeting.resumeFromStage === "summarizing");

  const resumeFromStage = shouldReTranscribeQueuedRetry
    ? "transcribing"
    : meeting.resumeFromStage;

  return {
    language: selectedLanguage,
    resumeFromStage,
    clearDetectedLanguage:
      languageChanged ||
      resumeFromStage === "normalizing" ||
      resumeFromStage === "transcribing",
  };
}

function assertCanRegenerateSummary(meeting: MeetingSummaryRegenerationRow) {
  if (meeting.status !== "done") {
    throw new MeetingMutationError(
      "Only completed meetings can regenerate summaries.",
      400,
    );
  }

  if (meeting.latestSummaryVersionId === null) {
    throw new MeetingMutationError(
      "Only meetings with an existing summary can regenerate summaries.",
      400,
    );
  }

  if (
    meeting.summaryRegenerationStatus === "pending" ||
    meeting.summaryRegenerationStatus === "processing"
  ) {
    throw new MeetingMutationError(
      "Summary regeneration is already in progress.",
      400,
    );
  }
}

function createRetryMeetingUpdate(
  meeting: MeetingFailureRow,
  selectedLanguage: MeetingLanguage,
): RetryMeetingUpdate {
  if (!isRetryableFailedStage(meeting.failedAtStage)) {
    throw new MeetingMutationError("Only failed meetings can be retried.", 400);
  }

  const failedAtStage = meeting.failedAtStage;
  const languageChanged = selectedLanguage !== meeting.language;
  const resumeFromStage =
    languageChanged && failedAtStage !== "normalizing"
      ? "transcribing"
      : failedAtStage;

  return {
    status: "pending",
    errorKind: null,
    errorMessage: null,
    failedAtStage: null,
    resumeFromStage,
    transcriptionProgress: null,
    language: selectedLanguage,
    clearDetectedLanguage:
      languageChanged ||
      resumeFromStage === "normalizing" ||
      resumeFromStage === "transcribing",
  };
}

function validateSpeakerLabel(speakerLabel: unknown) {
  if (
    typeof speakerLabel !== "string" ||
    !speakerLabelPattern.test(speakerLabel)
  ) {
    throw new MeetingMutationError("Choose a valid speaker label.", 400);
  }

  return speakerLabel;
}

function validateSpeakerName(name: unknown) {
  if (typeof name !== "string") {
    throw new MeetingMutationError("Enter a speaker name.", 400);
  }

  const trimmedName = name.trim();

  if (trimmedName.length > maxSpeakerNameLength) {
    throw new MeetingMutationError(
      "Speaker name must be 100 characters or fewer.",
      400,
    );
  }

  return trimmedName;
}

function validateMeetingTitle(title: unknown) {
  if (typeof title !== "string") {
    throw new MeetingMutationError("Enter a meeting title.", 400);
  }

  const trimmedTitle = title.trim();

  if (trimmedTitle.length === 0) {
    throw new MeetingMutationError("Meeting title cannot be empty.", 400);
  }

  if (trimmedTitle.length > maxMeetingTitleLength) {
    throw new MeetingMutationError(
      "Meeting title must be 200 characters or fewer.",
      400,
    );
  }

  return trimmedTitle;
}

async function deleteMeetingById(meetingId: string): Promise<boolean> {
  const database = await getDatabase();
  const rows = await database
    .delete(meetings)
    .where(eq(meetings.id, meetingId))
    .returning({ id: meetings.id });

  return rows.length > 0;
}

async function deleteSpeakerMapping(
  meetingId: string,
  speakerLabel: string,
): Promise<void> {
  const database = await getDatabase();
  await database
    .delete(speakerMappings)
    .where(
      and(
        eq(speakerMappings.meetingId, meetingId),
        eq(speakerMappings.speakerLabel, speakerLabel),
      ),
    );
}

async function findMeetingById(
  meetingId: string,
): Promise<{ id: string } | null> {
  const database = await getDatabase();
  const [row] = await database
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);

  return row ?? null;
}

async function findMeetingFailureById(
  meetingId: string,
): Promise<MeetingFailureRow | null> {
  const database = await getDatabase();
  const [row] = await database
    .select({
      id: meetings.id,
      status: meetings.status,
      errorKind: meetings.errorKind,
      errorMessage: meetings.errorMessage,
      failedAtStage: meetings.failedAtStage,
      language: meetings.language,
      detectedLanguage: meetings.detectedLanguage,
    })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);

  return row ?? null;
}

async function findMeetingStatusById(
  meetingId: string,
): Promise<MeetingStatusRow | null> {
  const database = await getDatabase();
  const [row] = await database
    .select({
      id: meetings.id,
      status: meetings.status,
      language: meetings.language,
      resumeFromStage: meetings.resumeFromStage,
    })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);

  return row ?? null;
}

async function findMeetingSummaryRegenerationById(
  meetingId: string,
): Promise<MeetingSummaryRegenerationRow | null> {
  const database = await getDatabase();
  const [row] = await database
    .select({
      id: meetings.id,
      status: meetings.status,
      summaryRegenerationStatus: meetings.summaryRegenerationStatus,
      latestSummaryVersionId: meetings.latestSummaryVersionId,
    })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);

  if (row === undefined) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    summaryRegenerationStatus: row.summaryRegenerationStatus,
    latestSummaryVersionId: row.latestSummaryVersionId,
  };
}

async function speakerLabelExistsForMeeting(
  meetingId: string,
  speakerLabel: string,
): Promise<boolean> {
  const database = await getDatabase();
  const [row] = await database
    .select({ id: transcriptSegments.id })
    .from(transcriptSegments)
    .where(
      and(
        eq(transcriptSegments.meetingId, meetingId),
        eq(transcriptSegments.speakerLabel, speakerLabel),
      ),
    )
    .limit(1);

  return row !== undefined;
}

async function upsertSpeakerMapping(
  meetingId: string,
  speakerLabel: string,
  name: string,
): Promise<SaveSpeakerMappingResult> {
  const database = await getDatabase();
  const [row] = await database
    .insert(speakerMappings)
    .values({ meetingId, speakerLabel, name })
    .onConflictDoUpdate({
      target: [speakerMappings.meetingId, speakerMappings.speakerLabel],
      set: { name, updatedAt: new Date() },
    })
    .returning({
      meetingId: speakerMappings.meetingId,
      speakerLabel: speakerMappings.speakerLabel,
      name: speakerMappings.name,
    });

  return row;
}

async function removeStoredMeetingDirectory(meetingId: string) {
  await removeMeetingStorageDirectory({ meetingId });
}

async function updateLanguageById(
  meetingId: string,
  update: UpdateMeetingLanguagePersistence,
): Promise<UpdateMeetingLanguageResult | null> {
  const database = await getDatabase();
  const [row] = await database
    .update(meetings)
    .set({
      language: update.language,
      detectedLanguage: update.clearDetectedLanguage
        ? null
        : drizzleSql`${meetings.detectedLanguage}`,
      resumeFromStage: update.resumeFromStage,
      updatedAt: new Date(),
    })
    .where(and(eq(meetings.id, meetingId), eq(meetings.status, "pending")))
    .returning({ id: meetings.id, language: meetings.language });

  return row ?? null;
}

async function updateTitleById(
  meetingId: string,
  title: string,
): Promise<UpdateMeetingTitleResult | null> {
  const database = await getDatabase();
  const [row] = await database
    .update(meetings)
    .set({ title, updatedAt: new Date() })
    .where(eq(meetings.id, meetingId))
    .returning({ id: meetings.id, title: meetings.title });

  return row ?? null;
}

async function queueSummaryRegenerationById(
  meetingId: string,
): Promise<RegenerateSummaryResult | null> {
  const { sqlClient } = await import("~/db/client.server");

  return sqlClient.begin(async (sql) => {
    const [row] = await sql`
      update meetings
      set
        summary_regeneration_status = 'pending',
        summary_regeneration_processing_started_at = null,
        updated_at = now()
      where id = ${meetingId}
        and status = 'done'
        and summary_regeneration_status in ('idle', 'failed')
        and latest_summary_version_id is not null
      returning id
    `;

    if (row === undefined) {
      return null;
    }

    await sql`select pg_notify('meetings_pending', ${meetingId})`;

    return { id: row.id };
  });
}

async function retryMeetingById(
  meetingId: string,
  update: RetryMeetingUpdate,
): Promise<RetryMeetingResult | null> {
  const { sqlClient } = await import("~/db/client.server");

  return sqlClient.begin(async (sql) => {
    const [row] = await sql`
      update meetings
      set
        status = ${update.status},
        error_kind = ${update.errorKind},
        error_message = ${update.errorMessage},
        failed_at_stage = ${update.failedAtStage},
        resume_from_stage = ${update.resumeFromStage},
        transcription_progress = ${update.transcriptionProgress},
        language = ${update.language},
        detected_language = case
          when ${update.clearDetectedLanguage} then null
          else detected_language
        end,
        updated_at = now()
      where id = ${meetingId}
        and status = 'error'
      returning id, resume_from_stage as "resumeFromStage"
    `;

    if (row === undefined || row.resumeFromStage === null) {
      return null;
    }

    await sql`select pg_notify('meetings_pending', ${meetingId})`;

    return { id: row.id, resumeFromStage: row.resumeFromStage };
  });
}

async function getDatabase() {
  const { db } = await import("~/db/client.server");

  return db;
}
