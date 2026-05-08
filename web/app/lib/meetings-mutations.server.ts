import { and, eq } from "drizzle-orm";
import { meetings, speakerMappings, transcriptSegments } from "~/db/schema";
import { isMeetingId } from "./meeting-id";
import { removeMeetingDirectory as removeMeetingStorageDirectory } from "./meeting-storage.server";

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
