import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, mock, test } from "bun:test";
import type { MeetingStatus } from "~/db/schema";
import { removeMeetingDirectory } from "./meeting-storage.server";
import {
  deleteMeetingAndArtifacts,
  MeetingMutationError,
  regenerateSummary,
  retryMeeting,
  saveSpeakerMapping,
  updateMeetingLanguage,
  updateMeetingTitle,
} from "./meetings-mutations.server";

const meetingId = "00000000-0000-4000-8000-000000000006";

describe("summary regeneration mutations", () => {
  test("queues regeneration for a done meeting with an existing summary", async () => {
    const queuedMeetings: string[] = [];

    const result = await regenerateSummary(
      { meetingId },
      {
        findMeetingSummaryRegenerationById: async (id) => ({
          id,
          status: "done",
          summaryRegenerationStatus: "idle",
          latestSummaryVersionId: "00000000-0000-4000-8000-000000000106",
        }),
        queueSummaryRegenerationById: async (id) => {
          queuedMeetings.push(id);
          return { id };
        },
      },
    );

    expect(result).toEqual({ id: meetingId });
    expect(queuedMeetings).toEqual([meetingId]);
  });

  test("notifies the pending queue in the same transaction when regeneration is persisted", async () => {
    const statements: string[] = [];
    let transactionWasOpened = false;

    mock.module("~/db/client.server", () => ({
      sqlClient: {
        begin: async (
          callback: (
            sql: (
              strings: TemplateStringsArray,
              ...values: unknown[]
            ) => Promise<Array<{ id: string }>>,
          ) => Promise<unknown>,
        ) => {
          transactionWasOpened = true;

          return callback(async (strings, ...values) => {
            statements.push(
              `${Array.from(strings).join("?")} :: ${values.join(",")}`,
            );

            if (Array.from(strings).join(" ").includes("returning")) {
              return [{ id: meetingId }];
            }

            return [];
          });
        },
      },
    }));

    const result = await regenerateSummary(
      { meetingId },
      {
        findMeetingSummaryRegenerationById: async (id) => ({
          id,
          status: "done",
          summaryRegenerationStatus: "idle",
          latestSummaryVersionId: "00000000-0000-4000-8000-000000000106",
        }),
      },
    );

    expect(result).toEqual({ id: meetingId });
    expect(transactionWasOpened).toBe(true);
    expect(
      statements.some((statement) => statement.includes("update meetings")),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes("summary_regeneration_status = 'pending'"),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes("summary_regeneration_processing_started_at = null"),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.includes("updated_at = now()")),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes("latest_summary_version_id is not null"),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.includes("from summaries")),
    ).toBe(false);
    expect(
      statements.some((statement) =>
        statement.includes("pg_notify('meetings_pending'"),
      ),
    ).toBe(true);
  });

  test("allows a failed regeneration state to be queued again", async () => {
    const queuedMeetings: string[] = [];

    const result = await regenerateSummary(
      { meetingId },
      {
        findMeetingSummaryRegenerationById: async (id) => ({
          id,
          status: "done",
          summaryRegenerationStatus: "failed",
          latestSummaryVersionId: "00000000-0000-4000-8000-000000000106",
        }),
        queueSummaryRegenerationById: async (id) => {
          queuedMeetings.push(id);
          return { id };
        },
      },
    );

    expect(result).toEqual({ id: meetingId });
    expect(queuedMeetings).toEqual([meetingId]);
  });

  test("rejects invalid and missing meetings before queueing regeneration", async () => {
    let findWasCalled = false;
    let queueWasCalled = false;

    const invalidIdError = await captureMeetingMutationError(
      regenerateSummary(
        { meetingId: "not-a-uuid" },
        {
          findMeetingSummaryRegenerationById: async () => {
            findWasCalled = true;
            return null;
          },
          queueSummaryRegenerationById: async () => {
            queueWasCalled = true;
            return { id: meetingId };
          },
        },
      ),
    );

    const missingMeetingError = await captureMeetingMutationError(
      regenerateSummary(
        { meetingId },
        {
          findMeetingSummaryRegenerationById: async () => null,
          queueSummaryRegenerationById: async () => {
            queueWasCalled = true;
            return { id: meetingId };
          },
        },
      ),
    );

    expect(invalidIdError.status).toBe(404);
    expect(missingMeetingError.status).toBe(404);
    expect(findWasCalled).toBe(false);
    expect(queueWasCalled).toBe(false);
  });

  test("rejects meetings that are not done or do not have an existing summary", async () => {
    const inputs = [
      {
        status: "summarizing" as const,
        summaryRegenerationStatus: "idle" as const,
        latestSummaryVersionId: "00000000-0000-4000-8000-000000000106",
        message: "Only completed meetings can regenerate summaries.",
      },
      {
        status: "done" as const,
        summaryRegenerationStatus: "idle" as const,
        latestSummaryVersionId: null,
        message:
          "Only meetings with an existing summary can regenerate summaries.",
      },
    ];

    for (const input of inputs) {
      let queueWasCalled = false;
      const error = await captureMeetingMutationError(
        regenerateSummary(
          { meetingId },
          {
            findMeetingSummaryRegenerationById: async (id) => ({
              id,
              status: input.status,
              summaryRegenerationStatus: input.summaryRegenerationStatus,
              latestSummaryVersionId: input.latestSummaryVersionId,
            }),
            queueSummaryRegenerationById: async () => {
              queueWasCalled = true;
              return { id: meetingId };
            },
          },
        ),
      );

      expect(error.status).toBe(400);
      expect(error.message).toBe(input.message);
      expect(queueWasCalled).toBe(false);
    }
  });

  test("returns the current validation error when queueing loses a race", async () => {
    const observedStates: Array<"idle" | "pending"> = ["idle", "pending"];

    const error = await captureMeetingMutationError(
      regenerateSummary(
        { meetingId },
        {
          findMeetingSummaryRegenerationById: async (id) => {
            const summaryRegenerationStatus = observedStates.shift();

            if (summaryRegenerationStatus === undefined) {
              throw new Error("unexpected extra regeneration state lookup");
            }

            return {
              id,
              status: "done",
              summaryRegenerationStatus,
              latestSummaryVersionId: "00000000-0000-4000-8000-000000000106",
            };
          },
          queueSummaryRegenerationById: async () => null,
        },
      ),
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe("Summary regeneration is already in progress.");
  });

  test("rejects meetings with active summary regeneration", async () => {
    for (const summaryRegenerationStatus of [
      "pending",
      "processing",
    ] as const) {
      let queueWasCalled = false;
      const error = await captureMeetingMutationError(
        regenerateSummary(
          { meetingId },
          {
            findMeetingSummaryRegenerationById: async (id) => ({
              id,
              status: "done",
              summaryRegenerationStatus,
              latestSummaryVersionId: "00000000-0000-4000-8000-000000000106",
            }),
            queueSummaryRegenerationById: async () => {
              queueWasCalled = true;
              return { id: meetingId };
            },
          },
        ),
      );

      expect(error.status).toBe(400);
      expect(error.message).toBe(
        "Summary regeneration is already in progress.",
      );
      expect(queueWasCalled).toBe(false);
    }
  });
});

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
        language: "sr" | "en" | null;
        clearDetectedLanguage: boolean;
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
          language: "sr",
          detectedLanguage: null,
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
          language: "sr",
          clearDetectedLanguage: false,
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
          language: "sr",
          detectedLanguage: null,
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
            findMeetingFailureById: async (id) => ({
              id,
              ...input,
              language: "sr",
              detectedLanguage: null,
            }),
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
              language: "sr",
              detectedLanguage: null,
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

  test("retry with changed language resumes from transcription and clears detected language", async () => {
    const persistedRows: Array<{
      language: "sr" | "en" | null;
      resumeFromStage: MeetingStatus;
      clearDetectedLanguage: boolean;
    }> = [];

    const result = await retryMeeting(
      { meetingId, language: "en" },
      {
        findMeetingFailureById: async (id) => ({
          id,
          status: "error",
          errorKind: "diarization_failed",
          errorMessage: "speaker clustering failed",
          failedAtStage: "diarizing",
          language: "sr",
          detectedLanguage: null,
        }),
        retryMeetingById: async (id, update) => {
          persistedRows.push({
            language: update.language,
            resumeFromStage: update.resumeFromStage,
            clearDetectedLanguage: update.clearDetectedLanguage,
          });
          return { id, resumeFromStage: update.resumeFromStage };
        },
      },
    );

    expect(result).toEqual({ id: meetingId, resumeFromStage: "transcribing" });
    expect(persistedRows).toEqual([
      {
        language: "en",
        resumeFromStage: "transcribing",
        clearDetectedLanguage: true,
      },
    ]);
  });

  test("retry with changed language from normalization resumes from normalization", async () => {
    const persistedRows: Array<{
      language: "sr" | "en" | null;
      resumeFromStage: MeetingStatus;
      clearDetectedLanguage: boolean;
    }> = [];

    const result = await retryMeeting(
      { meetingId, language: "auto" },
      {
        findMeetingFailureById: async (id) => ({
          id,
          status: "error",
          errorKind: "normalization_failed",
          errorMessage: "ffmpeg failed",
          failedAtStage: "normalizing",
          language: "sr",
          detectedLanguage: null,
        }),
        retryMeetingById: async (id, update) => {
          persistedRows.push({
            language: update.language,
            resumeFromStage: update.resumeFromStage,
            clearDetectedLanguage: update.clearDetectedLanguage,
          });
          return { id, resumeFromStage: update.resumeFromStage };
        },
      },
    );

    expect(result).toEqual({ id: meetingId, resumeFromStage: "normalizing" });
    expect(persistedRows).toEqual([
      {
        language: null,
        resumeFromStage: "normalizing",
        clearDetectedLanguage: true,
      },
    ]);
  });

  test("retry with unchanged later stage language preserves detected language", async () => {
    const persistedRows: Array<{
      language: "sr" | "en" | null;
      resumeFromStage: MeetingStatus;
      clearDetectedLanguage: boolean;
    }> = [];

    await retryMeeting(
      { meetingId, language: "auto" },
      {
        findMeetingFailureById: async (id) => ({
          id,
          status: "error",
          errorKind: "summarization_failed",
          errorMessage: "summary failed",
          failedAtStage: "summarizing",
          language: null,
          detectedLanguage: "sr",
        }),
        retryMeetingById: async (id, update) => {
          persistedRows.push({
            language: update.language,
            resumeFromStage: update.resumeFromStage,
            clearDetectedLanguage: update.clearDetectedLanguage,
          });
          return { id, resumeFromStage: update.resumeFromStage };
        },
      },
    );

    expect(persistedRows).toEqual([
      {
        language: null,
        resumeFromStage: "summarizing",
        clearDetectedLanguage: false,
      },
    ]);
  });

  test("rejects invalid retry language before retry persistence", async () => {
    let retryWasCalled = false;

    const emptyError = await captureMeetingMutationError(
      retryMeeting(
        { meetingId, language: "" },
        {
          findMeetingFailureById: async (id) => ({
            id,
            status: "error",
            errorKind: "diarization_failed",
            errorMessage: "speaker clustering failed",
            failedAtStage: "diarizing",
            language: "sr",
            detectedLanguage: null,
          }),
          retryMeetingById: async () => {
            retryWasCalled = true;
            return { id: meetingId, resumeFromStage: "diarizing" };
          },
        },
      ),
    );

    const error = await captureMeetingMutationError(
      retryMeeting(
        { meetingId, language: "de" },
        {
          findMeetingFailureById: async (id) => ({
            id,
            status: "error",
            errorKind: "diarization_failed",
            errorMessage: "speaker clustering failed",
            failedAtStage: "diarizing",
            language: "sr",
            detectedLanguage: null,
          }),
          retryMeetingById: async () => {
            retryWasCalled = true;
            return { id: meetingId, resumeFromStage: "diarizing" };
          },
        },
      ),
    );

    expect(emptyError.status).toBe(400);
    expect(emptyError.message).toBe("Choose Serbian, English, or Auto-detect.");
    expect(error.status).toBe(400);
    expect(error.message).toBe("Choose Serbian, English, or Auto-detect.");
    expect(retryWasCalled).toBe(false);
  });
});

describe("meeting metadata mutations", () => {
  test("updates language for a pending meeting and clears detected language", async () => {
    const updates: Array<{
      id: string;
      language: "sr" | "en" | null;
      resumeFromStage: MeetingStatus | null;
      clearDetectedLanguage: boolean;
    }> = [];

    const result = await updateMeetingLanguage(
      { meetingId, language: "auto" },
      {
        findMeetingStatusById: async (id) => ({
          id,
          status: "pending",
          language: "sr",
          resumeFromStage: null,
        }),
        updateMeetingLanguageById: async (id, update) => {
          updates.push({ id, ...update });
          return { id, language: update.language };
        },
      },
    );

    expect(result).toEqual({ id: meetingId, language: null });
    expect(updates).toEqual([
      {
        id: meetingId,
        language: null,
        resumeFromStage: null,
        clearDetectedLanguage: true,
      },
    ]);
  });

  test("changing language on a pending later-stage retry forces transcription resume", async () => {
    const updates: Array<{
      language: "sr" | "en" | null;
      resumeFromStage: MeetingStatus | null;
      clearDetectedLanguage: boolean;
    }> = [];

    const result = await updateMeetingLanguage(
      { meetingId, language: "en" },
      {
        findMeetingStatusById: async (id) => ({
          id,
          status: "pending",
          language: "sr",
          resumeFromStage: "diarizing",
        }),
        updateMeetingLanguageById: async (id, update) => {
          updates.push(update);
          return { id, language: update.language };
        },
      },
    );

    expect(result).toEqual({ id: meetingId, language: "en" });
    expect(updates).toEqual([
      {
        language: "en",
        resumeFromStage: "transcribing",
        clearDetectedLanguage: true,
      },
    ]);
  });

  test("saving the same language on a pending later-stage retry preserves detected language", async () => {
    const updates: Array<{
      language: "sr" | "en" | null;
      resumeFromStage: MeetingStatus | null;
      clearDetectedLanguage: boolean;
    }> = [];

    const result = await updateMeetingLanguage(
      { meetingId, language: "auto" },
      {
        findMeetingStatusById: async (id) => ({
          id,
          status: "pending",
          language: null,
          resumeFromStage: "summarizing",
        }),
        updateMeetingLanguageById: async (id, update) => {
          updates.push(update);
          return { id, language: update.language };
        },
      },
    );

    expect(result).toEqual({ id: meetingId, language: null });
    expect(updates).toEqual([
      {
        language: null,
        resumeFromStage: "summarizing",
        clearDetectedLanguage: false,
      },
    ]);
  });

  test("rejects invalid or missing language values before persisting", async () => {
    let updateWasCalled = false;

    const missingError = await captureMeetingMutationError(
      updateMeetingLanguage(
        { meetingId, language: null },
        {
          findMeetingStatusById: async (id) => ({
            id,
            status: "pending",
            language: "sr",
            resumeFromStage: null,
          }),
          updateMeetingLanguageById: async () => {
            updateWasCalled = true;
            return { id: meetingId, language: "sr" };
          },
        },
      ),
    );

    const error = await captureMeetingMutationError(
      updateMeetingLanguage(
        { meetingId, language: "de" },
        {
          findMeetingStatusById: async (id) => ({
            id,
            status: "pending",
            language: "sr",
            resumeFromStage: null,
          }),
          updateMeetingLanguageById: async () => {
            updateWasCalled = true;
            return { id: meetingId, language: "sr" };
          },
        },
      ),
    );

    expect(missingError.status).toBe(400);
    expect(missingError.message).toBe(
      "Choose Serbian, English, or Auto-detect.",
    );
    expect(error.status).toBe(400);
    expect(error.message).toBe("Choose Serbian, English, or Auto-detect.");
    expect(updateWasCalled).toBe(false);
  });

  test("rejects language updates for non-pending meetings", async () => {
    for (const status of ["normalizing", "done", "error"] as const) {
      let updateWasCalled = false;
      const error = await captureMeetingMutationError(
        updateMeetingLanguage(
          { meetingId, language: "en" },
          {
            findMeetingStatusById: async (id) => ({
              id,
              status,
              language: "sr",
              resumeFromStage: null,
            }),
            updateMeetingLanguageById: async () => {
              updateWasCalled = true;
              return { id: meetingId, language: "en" };
            },
          },
        ),
      );

      expect(error.status).toBe(400);
      expect(error.message).toBe(
        "Language can only be changed while the meeting is pending.",
      );
      expect(updateWasCalled).toBe(false);
    }
  });

  test("returns current status gate when pending language update loses a race", async () => {
    const observedStatuses: MeetingStatus[] = ["pending", "transcribing"];

    const error = await captureMeetingMutationError(
      updateMeetingLanguage(
        { meetingId, language: "en" },
        {
          findMeetingStatusById: async (id) => {
            const status = observedStatuses.shift();

            if (status === undefined) {
              throw new Error("unexpected extra language status lookup");
            }

            return { id, status, language: "sr", resumeFromStage: null };
          },
          updateMeetingLanguageById: async () => null,
        },
      ),
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe(
      "Language can only be changed while the meeting is pending.",
    );
  });

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
