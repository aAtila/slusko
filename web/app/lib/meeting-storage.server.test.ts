import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  getMeetingsStorageRoot,
  meetingDirectoryPath,
  removeMeetingDirectory,
} from "./meeting-storage.server";

describe("meeting storage helpers", () => {
  test("resolves the default or configured meetings storage directory", () => {
    expect(getMeetingsStorageRoot({})).toBe("/data/meetings");
    expect(
      getMeetingsStorageRoot({ MEETINGS_STORAGE_DIR: "/tmp/slusko-meetings" }),
    ).toBe("/tmp/slusko-meetings");
    expect(
      meetingDirectoryPath({
        meetingId: "00000000-0000-4000-8000-000000000006",
        meetingsStorageRoot: "/tmp/slusko-meetings",
      }),
    ).toBe(
      path.join("/tmp/slusko-meetings", "00000000-0000-4000-8000-000000000006"),
    );
  });

  test("rejects path-ish meeting ids before resolving storage paths", async () => {
    const meetingsStorageRoot = await mkdtempRoot();

    expect(() =>
      meetingDirectoryPath({
        meetingId: "../not-a-meeting",
        meetingsStorageRoot,
      }),
    ).toThrow("Meeting storage paths require a valid meeting id.");
    await expect(
      removeMeetingDirectory({
        meetingId: "00000000-0000-4000-8000-000000000006/../danger",
        meetingsStorageRoot,
      }),
    ).rejects.toThrow("Meeting storage paths require a valid meeting id.");
  });

  test("removes a meeting directory recursively and ignores missing directories", async () => {
    const meetingsStorageRoot = await mkdtempRoot();
    const meetingId = "00000000-0000-4000-8000-000000000006";
    const nestedArtifact = path.join(
      meetingsStorageRoot,
      meetingId,
      "nested",
      "normalized.wav",
    );

    await mkdir(path.dirname(nestedArtifact), { recursive: true });
    await writeFile(nestedArtifact, "normalized audio");

    await removeMeetingDirectory({ meetingId, meetingsStorageRoot });
    await expect(
      stat(path.join(meetingsStorageRoot, meetingId)),
    ).rejects.toThrow();
    await expect(
      removeMeetingDirectory({ meetingId, meetingsStorageRoot }),
    ).resolves.toBeUndefined();
  });
});

async function mkdtempRoot() {
  const { mkdtemp } = await import("node:fs/promises");

  return mkdtemp(path.join(os.tmpdir(), "slusko-meeting-storage-"));
}
