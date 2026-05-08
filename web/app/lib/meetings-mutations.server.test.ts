import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, mock, test } from "bun:test";
import { removeMeetingDirectory } from "./meeting-storage.server";
import {
  deleteMeetingAndArtifacts,
  MeetingMutationError,
  retryMeeting,
  saveSpeakerMapping,
  updateMeetingTitle,
} from "./meetings-mutations.server";

const meetingId = "00000000-0000-4000-8000-000000000006";

describe("speaker mapping mutations", () => {
  test("trims and upserts a speaker mapping scoped to one meeting", async () => {
    const calls: Array<{
      meetingId: string;
      speakerLabel: string;
      name: string;
    }> = [];

    const result = await saveSpeakerMapping(
      { meetingId, speakerLabel: "SPEAKER_00", name: "  Atila  " },
      {
        findMeetingById: async (id) => ({ id }),
        speakerLabelExistsForMeeting: async () => true,
        upsertSpeakerMapping: async (id, speakerLabel, name) => {
          calls.push({ meetingId: id, speakerLabel, name });
          return { meetingId: id, speakerLabel, name };
        },
      },
    );

    expect(result).toEqual({
      meetingId,
      speakerLabel: "SPEAKER_00",
      name: "Atila",
    });
    expect(calls).toEqual([
      { meetingId, speakerLabel: "SPEAKER_00", name: "Atila" },
    ]);
  });

  test("clears a mapping by deleting the meeting-scoped row when name is blank", async () => {
    const deletedRows: Array<{ meetingId: string; speakerLabel: string }> = [];

    const result = await saveSpeakerMapping(
      { meetingId, speakerLabel: "SPEAKER_01", name: "   " },
      {
        findMeetingById: async (id) => ({ id }),
        speakerLabelExistsForMeeting: async () => true,
        deleteSpeakerMapping: async (id, speakerLabel) => {
          deletedRows.push({ meetingId: id, speakerLabel });
        },
        upsertSpeakerMapping: async () => {
          throw new Error("blank names should not be upserted");
        },
      },
    );

    expect(result).toEqual({
      meetingId,
      speakerLabel: "SPEAKER_01",
      name: null,
    });
    expect(deletedRows).toEqual([{ meetingId, speakerLabel: "SPEAKER_01" }]);
  });

  test("rejects speaker mappings for labels not discovered in the meeting transcript", async () => {
    let persisted = false;

    const error = await captureMeetingMutationError(
      saveSpeakerMapping(
        { meetingId, speakerLabel: "SPEAKER_99", name: "Atila" },
        {
          findMeetingById: async (id) => ({ id }),
          speakerLabelExistsForMeeting: async () => false,
          upsertSpeakerMapping: async () => {
            persisted = true;
            return { meetingId, speakerLabel: "SPEAKER_99", name: "Atila" };
          },
        },
      ),
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe("Choose a discovered speaker label.");
    expect(persisted).toBe(false);
  });

  test("accepts speaker mappings for labels discovered in the meeting transcript", async () => {
    const result = await saveSpeakerMapping(
      { meetingId, speakerLabel: "SPEAKER_00", name: "Atila" },
      {
        findMeetingById: async (id) => ({ id }),
        speakerLabelExistsForMeeting: async () => true,
        upsertSpeakerMapping: async (id, speakerLabel, name) => ({
          meetingId: id,
          speakerLabel,
          name,
        }),
      },
    );

    expect(result).toEqual({
      meetingId,
      speakerLabel: "SPEAKER_00",
      name: "Atila",
    });
  });

  test("rejects invalid speaker mapping input before persisting", async () => {
    const invalidInputs: Array<{
      speakerLabel: unknown;
      name: unknown;
      message: string;
    }> = [
      {
        speakerLabel: "speaker-00",
        name: "Atila",
        message: "Choose a valid speaker label.",
      },
      {
        speakerLabel: "SPEAKER_00",
        name: undefined,
        message: "Enter a speaker name.",
      },
      {
        speakerLabel: "SPEAKER_00",
        name: "a".repeat(101),
        message: "Speaker name must be 100 characters or fewer.",
      },
    ];

    for (const input of invalidInputs) {
      const error = await captureMeetingMutationError(
        saveSpeakerMapping(
          { meetingId, speakerLabel: input.speakerLabel, name: input.name },
          {
            findMeetingById: async (id) => ({ id }),
            speakerLabelExistsForMeeting: async () => true,
            upsertSpeakerMapping: async () => {
              throw new Error("invalid mappings must not be upserted");
            },
            deleteSpeakerMapping: async () => {
              throw new Error("invalid mappings must not be deleted");
            },
          },
        ),
      );

      expect(error.status).toBe(400);
      expect(error.message).toBe(input.message);
    }
  });

  test("treats invalid or unknown meeting ids as not found before persistence", async () => {
    let findWasCalled = false;
    let persistenceWasCalled = false;

    const invalidIdError = await captureMeetingMutationError(
      saveSpeakerMapping(
        { meetingId: "not-a-uuid", speakerLabel: "SPEAKER_00", name: "Atila" },
        {
          findMeetingById: async () => {
            findWasCalled = true;
            return { id: meetingId };
          },
          speakerLabelExistsForMeeting: async () => true,
          upsertSpeakerMapping: async () => {
            persistenceWasCalled = true;
            return { meetingId, speakerLabel: "SPEAKER_00", name: "Atila" };
          },
        },
      ),
    );

    const missingMeetingError = await captureMeetingMutationError(
      saveSpeakerMapping(
        { meetingId, speakerLabel: "SPEAKER_00", name: "Atila" },
        {
          findMeetingById: async () => null,
          speakerLabelExistsForMeeting: async () => true,
          upsertSpeakerMapping: async () => {
            persistenceWasCalled = true;
            return { meetingId, speakerLabel: "SPEAKER_00", name: "Atila" };
          },
        },
      ),
    );

    expect(invalidIdError.status).toBe(404);
    expect(missingMeetingError.status).toBe(404);
    expect(findWasCalled).toBe(false);
    expect(persistenceWasCalled).toBe(false);
  });
});

describe("meeting retry mutations", () => {
  test("queues a retry from the failed stage and clears failure fields", async () => {
    const persistedRows: Array<{
      meetingId: string;
      update: {
        status: "pending";
        errorKind: null;
        errorMessage: null;
        failedAtStage: null;
        resumeFromStage: string;
        transcriptionProgress: null;
      };
    }> = [];

    const result = await retryMeeting(
      { meetingId },
      {
        findMeetingFailureById: async (id) => ({
          id,
          status: "error",
          errorKind: "diarization_failed",
          errorMessage: "speaker clustering failed",
          failedAtStage: "diarizing",
        }),
        retryMeetingById: async (id, update) => {
          persistedRows.push({ meetingId: id, update });
          return { id, resumeFromStage: update.resumeFromStage };
        },
      },
    );

    expect(result).toEqual({ id: meetingId, resumeFromStage: "diarizing" });
    expect(persistedRows).toEqual([
      {
        meetingId,
        update: {
          status: "pending",
          errorKind: null,
          errorMessage: null,
          failedAtStage: null,
          resumeFromStage: "diarizing",
          transcriptionProgress: null,
        },
      },
    ]);
  });

  test("notifies the pending queue in the same transaction when retry is persisted", async () => {
    const statements: string[] = [];
    let transactionWasOpened = false;

    mock.module("~/db/client.server", () => ({
      sqlClient: {
        begin: async (
          callback: (
            sql: (
              strings: TemplateStringsArray,
              ...values: unknown[]
            ) => Promise<Array<{ id: string; resumeFromStage: string | null }>>,
          ) => Promise<unknown>,
        ) => {
          transactionWasOpened = true;

          return callback(async (strings, ...values) => {
            statements.push(
              `${Array.from(strings).join("?")} :: ${values.join(",")}`,
            );

            if (Array.from(strings).join(" ").includes("returning")) {
              return [{ id: meetingId, resumeFromStage: "diarizing" }];
            }

            return [];
          });
        },
      },
    }));

    const result = await retryMeeting(
      { meetingId },
      {
        findMeetingFailureById: async (id) => ({
          id,
          status: "error",
          errorKind: "diarization_failed",
          errorMessage: "speaker clustering failed",
          failedAtStage: "diarizing",
        }),
      },
    );

    expect(result).toEqual({ id: meetingId, resumeFromStage: "diarizing" });
    expect(transactionWasOpened).toBe(true);
    expect(
      statements.some((statement) => statement.includes("update meetings")),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes("pg_notify('meetings_pending'"),
      ),
    ).toBe(true);
  });

  test("rejects invalid and missing meetings before retry persistence", async () => {
    let findWasCalled = false;
    let retryWasCalled = false;

    const invalidIdError = await captureMeetingMutationError(
      retryMeeting(
        { meetingId: "not-a-uuid" },
        {
          findMeetingFailureById: async () => {
            findWasCalled = true;
            return null;
          },
          retryMeetingById: async () => {
            retryWasCalled = true;
            return { id: meetingId, resumeFromStage: "diarizing" };
          },
        },
      ),
    );

    const missingMeetingError = await captureMeetingMutationError(
      retryMeeting(
        { meetingId },
        {
          findMeetingFailureById: async () => null,
          retryMeetingById: async () => {
            retryWasCalled = true;
            return { id: meetingId, resumeFromStage: "diarizing" };
          },
        },
      ),
    );

    expect(invalidIdError.status).toBe(404);
    expect(missingMeetingError.status).toBe(404);
    expect(findWasCalled).toBe(false);
    expect(retryWasCalled).toBe(false);
  });

  test("rejects non-error meetings and failures without retryable stages", async () => {
    const inputs = [
      {
        status: "done" as const,
        errorKind: null,
        errorMessage: null,
        failedAtStage: null,
        message: "Only failed meetings can be retried.",
      },
      {
        status: "error" as const,
        errorKind: "unknown" as const,
        errorMessage: "unexpected",
        failedAtStage: null,
        message: "This meeting did not record a retryable failed stage.",
      },
    ];

    for (const input of inputs) {
      let retryWasCalled = false;
      const error = await captureMeetingMutationError(
        retryMeeting(
          { meetingId },
          {
            findMeetingFailureById: async (id) => ({ id, ...input }),
            retryMeetingById: async () => {
              retryWasCalled = true;
              return { id: meetingId, resumeFromStage: "diarizing" };
            },
          },
        ),
      );

      expect(error.status).toBe(400);
      expect(error.message).toBe(input.message);
      expect(retryWasCalled).toBe(false);
    }
  });

  test("rejects non-retryable failure kinds before retry persistence", async () => {
    const nonRetryableFailures = [
      {
        errorKind: "transcription_empty" as const,
        errorMessage: "No speech detected.",
        failedAtStage: "transcribing" as const,
        message:
          "This meeting cannot be retried because no speech was detected.",
      },
      {
        errorKind: "config_missing" as const,
        errorMessage: "OPENROUTER_API_KEY is missing.",
        failedAtStage: "summarizing" as const,
        message:
          "This meeting cannot be retried until the missing server configuration is fixed.",
      },
      {
        errorKind: "normalization_failed" as const,
        errorMessage: "invalid data found while decoding input",
        failedAtStage: "normalizing" as const,
        message:
          "This recording cannot be retried because the file appears to be corrupt or unsupported.",
      },
    ];

    for (const failure of nonRetryableFailures) {
      let retryWasCalled = false;
      const error = await captureMeetingMutationError(
        retryMeeting(
          { meetingId },
          {
            findMeetingFailureById: async (id) => ({
              id,
              status: "error",
              ...failure,
            }),
            retryMeetingById: async () => {
              retryWasCalled = true;
              return { id: meetingId, resumeFromStage: failure.failedAtStage };
            },
          },
        ),
      );

      expect(error.status).toBe(400);
      expect(error.message).toBe(failure.message);
      expect(retryWasCalled).toBe(false);
    }
  });
});

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
