import { rm } from "node:fs/promises";
import path from "node:path";
import { isMeetingId } from "./meeting-id";

const defaultMeetingsStorageRoot = "/data/meetings";

export function getMeetingsStorageRoot(
  environ: Record<string, string | undefined> = process.env,
) {
  return environ.MEETINGS_STORAGE_DIR ?? defaultMeetingsStorageRoot;
}

export function meetingDirectoryPath({
  meetingId,
  meetingsStorageRoot = getMeetingsStorageRoot(),
}: {
  meetingId: string;
  meetingsStorageRoot?: string;
}) {
  assertStorageMeetingId(meetingId);

  return path.join(meetingsStorageRoot, meetingId);
}

export async function removeMeetingDirectory({
  meetingId,
  meetingsStorageRoot,
}: {
  meetingId: string;
  meetingsStorageRoot?: string;
}) {
  await rm(meetingDirectoryPath({ meetingId, meetingsStorageRoot }), {
    force: true,
    recursive: true,
  });
}

function assertStorageMeetingId(meetingId: string) {
  if (!isMeetingId(meetingId)) {
    throw new TypeError("Meeting storage paths require a valid meeting id.");
  }
}
