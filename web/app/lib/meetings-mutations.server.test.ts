import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { removeMeetingDirectory } from "./meeting-storage.server";
import {
  deleteMeetingAndArtifacts,
  MeetingMutationError,
  updateMeetingTitle,
} from "./meetings-mutations.server";

const meetingId = "00000000-0000-4000-8000-000000000006";

describe("meeting metadata mutations", () => {
  test("trims and persists an updated meeting title", async () => {
    const updates: Array<{ id: string; title: string }> = [];

    const result = await updateMeetingTitle(
      { meetingId, title: "  Weekly planning  " },
      {
        updateMeetingTitleById: async (id, title) => {
          updates.push({ id, title });
          return { id, title };
        },
      },
    );

    expect(result).toEqual({ id: meetingId, title: "Weekly planning" });
    expect(updates).toEqual([{ id: meetingId, title: "Weekly planning" }]);
  });

  test("rejects invalid meeting titles before persisting", async () => {
    const invalidTitles: Array<{ title: unknown; message: string }> = [
      { title: undefined, message: "Enter a meeting title." },
      { title: "   ", message: "Meeting title cannot be empty." },
      {
        title: "a".repeat(201),
        message: "Meeting title must be 200 characters or fewer.",
      },
    ];

    for (const { title, message } of invalidTitles) {
      const error = await captureMeetingMutationError(
        updateMeetingTitle(
          { meetingId, title },
          {
            updateMeetingTitleById: async () => {
              throw new Error("invalid titles must not be persisted");
            },
          },
        ),
      );

      expect(error.status).toBe(400);
      expect(error.message).toBe(message);
    }
  });

  test("treats invalid or unknown meeting ids as not found", async () => {
    let updateWasCalled = false;

    const invalidIdError = await captureMeetingMutationError(
      updateMeetingTitle(
        { meetingId: "not-a-uuid", title: "New title" },
        {
          updateMeetingTitleById: async () => {
            updateWasCalled = true;
            return { id: meetingId, title: "New title" };
          },
        },
      ),
    );

    const missingMeetingError = await captureMeetingMutationError(
      updateMeetingTitle(
        { meetingId, title: "New title" },
        { updateMeetingTitleById: async () => null },
      ),
    );

    expect(invalidIdError.status).toBe(404);
    expect(missingMeetingError.status).toBe(404);
    expect(updateWasCalled).toBe(false);
  });

  test("rejects invalid delete ids before touching storage or the database", async () => {
    let findWasCalled = false;

    const error = await captureMeetingMutationError(
      deleteMeetingAndArtifacts(
        { meetingId: "not-a-uuid" },
        {
          findMeetingById: async () => {
            findWasCalled = true;
            return { id: meetingId };
          },
        },
      ),
    );

    expect(error.status).toBe(404);
    expect(findWasCalled).toBe(false);
  });

  test("does not remove artifacts when the meeting does not exist", async () => {
    const calls: string[] = [];

    const error = await captureMeetingMutationError(
      deleteMeetingAndArtifacts(
        { meetingId },
        {
          findMeetingById: async (id) => {
            calls.push(`find:${id}`);
            return null;
          },
          removeMeetingDirectory: async () => {
            calls.push("remove-storage");
          },
          deleteMeetingById: async () => {
            calls.push("delete-db");
            return true;
          },
        },
      ),
    );

    expect(error.status).toBe(404);
    expect(calls).toEqual([`find:${meetingId}`]);
  });

  test("removes artifacts before deleting the meeting row", async () => {
    const calls: string[] = [];

    const result = await deleteMeetingAndArtifacts(
      { meetingId },
      {
        findMeetingById: async (id) => {
          calls.push(`find:${id}`);
          return { id };
        },
        removeMeetingDirectory: async (id) => {
          calls.push(`remove-storage:${id}`);
        },
        deleteMeetingById: async (id) => {
          calls.push(`delete-db:${id}`);
          return true;
        },
      },
    );

    expect(result).toEqual({ id: meetingId });
    expect(calls).toEqual([
      `find:${meetingId}`,
      `remove-storage:${meetingId}`,
      `delete-db:${meetingId}`,
    ]);
  });

  test("removes stored artifacts and still deletes the row when the directory is already missing", async () => {
    const meetingsStorageRoot = await mkdtempRoot();
    const meetingDir = path.join(meetingsStorageRoot, meetingId);
    const normalizedPath = path.join(meetingDir, "normalized.wav");
    const deletedRows: string[] = [];

    await mkdir(meetingDir, { recursive: true });
    await writeFile(normalizedPath, "normalized audio");

    await deleteMeetingAndArtifacts(
      { meetingId },
      {
        findMeetingById: async (id) => ({ id }),
        removeMeetingDirectory: async (id) => {
          await removeMeetingDirectory({
            meetingId: id,
            meetingsStorageRoot,
          });
        },
        deleteMeetingById: async (id) => {
          deletedRows.push(id);
          return true;
        },
      },
    );

    await expect(stat(meetingDir)).rejects.toThrow();

    await deleteMeetingAndArtifacts(
      { meetingId },
      {
        findMeetingById: async (id) => ({ id }),
        removeMeetingDirectory: async (id) => {
          await removeMeetingDirectory({
            meetingId: id,
            meetingsStorageRoot,
          });
        },
        deleteMeetingById: async (id) => {
          deletedRows.push(id);
          return false;
        },
      },
    );

    expect(deletedRows).toEqual([meetingId, meetingId]);
  });
});

async function mkdtempRoot() {
  const { mkdtemp } = await import("node:fs/promises");

  return mkdtemp(path.join(os.tmpdir(), "slusko-meeting-mutations-"));
}

async function captureMeetingMutationError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MeetingMutationError) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected meeting mutation to fail");
}
