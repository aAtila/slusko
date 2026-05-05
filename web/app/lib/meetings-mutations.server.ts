import { eq } from "drizzle-orm";
import { meetings } from "~/db/schema";
import { isMeetingId } from "./meeting-id";
import { removeMeetingDirectory as removeMeetingStorageDirectory } from "./meeting-storage.server";

const maxMeetingTitleLength = 200;

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

async function removeStoredMeetingDirectory(meetingId: string) {
  await removeMeetingStorageDirectory({ meetingId });
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

async function getDatabase() {
  const { db } = await import("~/db/client.server");

  return db;
}
