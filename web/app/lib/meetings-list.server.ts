import { desc, eq } from "drizzle-orm";
import { meetings, type ErrorKind, type MeetingStatus } from "~/db/schema";
import type { HomeMeetingListItem, MeetingDetail } from "./meetings-list";

export type HomeMeetingListRow = {
  id: string;
  title: string;
  status: MeetingStatus;
  transcriptionProgress: number | null;
  durationSeconds: number | null;
  createdAt: Date;
};

export type MeetingDetailRow = HomeMeetingListRow & {
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  failedAtStage: MeetingStatus | null;
  updatedAt: Date;
};

type MeetingDetailLoaderOptions = {
  findMeetingById?: (meetingId: string) => Promise<MeetingDetailRow | null>;
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
) {
  if (!meetingId || !isUuid(meetingId)) {
    throw new Response("Meeting not found", { status: 404 });
  }

  const meeting = await loadMeetingDetail(meetingId, options);

  if (meeting === null) {
    throw new Response("Meeting not found", { status: 404 });
  }

  return { meeting };
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

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value,
  );
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
    errorKind: row.errorKind,
    errorMessage: row.errorMessage,
    failedAtStage: row.failedAtStage,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function getDatabase() {
  const { db } = await import("~/db/client.server");

  return db;
}
