import { asc, desc, eq } from "drizzle-orm";
import {
  meetings,
  speakerMappings,
  summaries,
  transcriptSegments,
  type ErrorKind,
  type MeetingStatus,
  type SummaryActionItem,
  type SummaryDecision,
  type SummaryOpenQuestion,
} from "~/db/schema";
import { isMeetingId } from "./meeting-id";
import type {
  HomeMeetingListItem,
  MeetingDetail,
  MeetingDetailRouteData,
  MeetingSummary,
  SpeakerMapping,
  TranscriptSegment,
} from "./meetings-list";

export type HomeMeetingListRow = {
  id: string;
  title: string;
  status: MeetingStatus;
  transcriptionProgress: number | null;
  durationSeconds: number | null;
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  failedAtStage: MeetingStatus | null;
  createdAt: Date;
};

export type MeetingDetailRow = HomeMeetingListRow & {
  updatedAt: Date;
};

export type SummaryRow = {
  overview: string;
  decisions: SummaryDecision[];
  actionItems: SummaryActionItem[];
  openQuestions: SummaryOpenQuestion[];
  updatedAt: Date;
};

export type TranscriptSegmentRow = TranscriptSegment;

export type SpeakerMappingRow = SpeakerMapping;

type MeetingDetailLoaderOptions = {
  findMeetingById?: (meetingId: string) => Promise<MeetingDetailRow | null>;
  findSummaryByMeetingId?: (meetingId: string) => Promise<SummaryRow | null>;
  findTranscriptSegmentsByMeetingId?: (
    meetingId: string,
  ) => Promise<TranscriptSegmentRow[]>;
  findSpeakerMappingsByMeetingId?: (
    meetingId: string,
  ) => Promise<SpeakerMappingRow[]>;
};

export async function loadHomeMeetings(): Promise<HomeMeetingListItem[]> {
  const database = await getDatabase();
  const rows = await database
    .select({
      id: meetings.id,
      title: meetings.title,
      status: meetings.status,
      transcriptionProgress: meetings.transcriptionProgress,
      durationSeconds: meetings.durationSeconds,
      errorKind: meetings.errorKind,
      errorMessage: meetings.errorMessage,
      failedAtStage: meetings.failedAtStage,
      createdAt: meetings.createdAt,
    })
    .from(meetings)
    .orderBy(desc(meetings.createdAt));

  return rows.map(serializeHomeMeetingRow);
}

export async function loadMeetingDetail(
  meetingId: string,
  options: MeetingDetailLoaderOptions = {},
): Promise<MeetingDetail | null> {
  const row = await (options.findMeetingById ?? findMeetingDetailRow)(
    meetingId,
  );

  return row === null ? null : serializeMeetingDetailRow(row);
}

export async function loadMeetingDetailRouteData(
  meetingId: string | undefined,
  options: MeetingDetailLoaderOptions = {},
): Promise<MeetingDetailRouteData> {
  if (!isMeetingId(meetingId)) {
    throw new Response("Meeting not found", { status: 404 });
  }

  const meeting = await loadMeetingDetail(meetingId, options);

  if (meeting === null) {
    throw new Response("Meeting not found", { status: 404 });
  }

  const summaryRow = await (
    options.findSummaryByMeetingId ?? findSummaryByMeetingId
  )(meeting.id);
  const transcriptSegmentRows = await (
    options.findTranscriptSegmentsByMeetingId ??
    findTranscriptSegmentsByMeetingId
  )(meeting.id);
  const speakerMappingRows = await (
    options.findSpeakerMappingsByMeetingId ?? findSpeakerMappingsByMeetingId
  )(meeting.id);

  return {
    meeting,
    summary: summaryRow === null ? null : serializeSummaryRow(summaryRow),
    transcriptSegments: transcriptSegmentRows.map(
      serializeTranscriptSegmentRow,
    ),
    speakerMappings: speakerMappingRows.map(serializeSpeakerMappingRow),
  };
}

async function findMeetingDetailRow(
  meetingId: string,
): Promise<MeetingDetailRow | null> {
  const database = await getDatabase();
  const [row] = await database
    .select({
      id: meetings.id,
      title: meetings.title,
      status: meetings.status,
      transcriptionProgress: meetings.transcriptionProgress,
      durationSeconds: meetings.durationSeconds,
      errorKind: meetings.errorKind,
      errorMessage: meetings.errorMessage,
      failedAtStage: meetings.failedAtStage,
      createdAt: meetings.createdAt,
      updatedAt: meetings.updatedAt,
    })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);

  return row ?? null;
}

function serializeHomeMeetingRow(row: HomeMeetingListRow): HomeMeetingListItem {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeMeetingDetailRow(row: MeetingDetailRow): MeetingDetail {
  return {
    ...serializeHomeMeetingRow(row),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeSummaryRow(row: SummaryRow): MeetingSummary {
  return {
    overview: row.overview,
    decisions: row.decisions,
    actionItems: row.actionItems,
    openQuestions: row.openQuestions,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeTranscriptSegmentRow(
  row: TranscriptSegmentRow,
): TranscriptSegment {
  return {
    id: row.id,
    startSeconds: row.startSeconds,
    endSeconds: row.endSeconds,
    speakerLabel: row.speakerLabel,
    text: row.text,
  };
}

function serializeSpeakerMappingRow(row: SpeakerMappingRow): SpeakerMapping {
  return {
    speakerLabel: row.speakerLabel,
    name: row.name,
  };
}

async function findSummaryByMeetingId(
  meetingId: string,
): Promise<SummaryRow | null> {
  const database = await getDatabase();
  const [row] = await database
    .select({
      overview: summaries.overview,
      decisions: summaries.decisions,
      actionItems: summaries.actionItems,
      openQuestions: summaries.openQuestions,
      updatedAt: summaries.updatedAt,
    })
    .from(summaries)
    .where(eq(summaries.meetingId, meetingId))
    .limit(1);

  return row ?? null;
}

async function findTranscriptSegmentsByMeetingId(
  meetingId: string,
): Promise<TranscriptSegmentRow[]> {
  const database = await getDatabase();

  return database
    .select({
      id: transcriptSegments.id,
      startSeconds: transcriptSegments.startSeconds,
      endSeconds: transcriptSegments.endSeconds,
      speakerLabel: transcriptSegments.speakerLabel,
      text: transcriptSegments.text,
    })
    .from(transcriptSegments)
    .where(eq(transcriptSegments.meetingId, meetingId))
    .orderBy(
      asc(transcriptSegments.startSeconds),
      asc(transcriptSegments.endSeconds),
    );
}

async function findSpeakerMappingsByMeetingId(
  meetingId: string,
): Promise<SpeakerMappingRow[]> {
  const database = await getDatabase();

  return database
    .select({
      speakerLabel: speakerMappings.speakerLabel,
      name: speakerMappings.name,
    })
    .from(speakerMappings)
    .where(eq(speakerMappings.meetingId, meetingId))
    .orderBy(asc(speakerMappings.speakerLabel));
}

async function getDatabase() {
  const { db } = await import("~/db/client.server");

  return db;
}
