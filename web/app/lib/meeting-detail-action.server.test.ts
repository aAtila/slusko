import { describe, expect, test } from "bun:test";
import {
  handleMeetingDetailAction,
  type MeetingDetailActionResult,
} from "./meeting-detail-action.server";
import { MeetingMutationError } from "./meetings-mutations.server";

const meetingId = "00000000-0000-4000-8000-000000000006";

describe("meeting detail route action", () => {
  test("queues summary regeneration through the regenerate mutation", async () => {
    const formData = new FormData();
    const calls: Array<{ meetingId: string | undefined }> = [];

    formData.set("_intent", "regenerate-summary");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        regenerateSummary: async (input) => {
          calls.push(input);
          return { id: input.meetingId ?? "" };
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: { ok: true, intent: "regenerate-summary" },
    } satisfies MeetingDetailActionResult);
    expect(calls).toEqual([{ meetingId }]);
  });

  test("returns summary regeneration validation feedback", async () => {
    const formData = new FormData();

    formData.set("_intent", "regenerate-summary");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        regenerateSummary: async () => {
          throw new MeetingMutationError(
            "Summary regeneration is already in progress.",
            400,
          );
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: {
        ok: false,
        intent: "regenerate-summary",
        error: "Summary regeneration is already in progress.",
      },
      status: 400,
    } satisfies MeetingDetailActionResult);
  });

  test("returns friendly feedback when summary regeneration queueing fails unexpectedly", async () => {
    const formData = new FormData();

    formData.set("_intent", "regenerate-summary");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        regenerateSummary: async () => {
          throw new Error("database unavailable");
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: {
        ok: false,
        intent: "regenerate-summary",
        error: "Could not queue summary regeneration. Please try again.",
      },
      status: 500,
    } satisfies MeetingDetailActionResult);
  });

  test("queues a retry through the retry mutation", async () => {
    const formData = new FormData();
    const calls: Array<{
      meetingId: string | undefined;
      language: unknown;
    }> = [];

    formData.set("_intent", "retry-meeting");
    formData.set("language", "en");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        retryMeeting: async (input) => {
          calls.push(input);
          return { id: input.meetingId ?? "", resumeFromStage: "diarizing" };
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: {
        ok: true,
        intent: "retry-meeting",
        resumeFromStage: "diarizing",
      },
    } satisfies MeetingDetailActionResult);
    expect(calls).toEqual([{ meetingId, language: "en" }]);
  });

  test("passes undefined for absent retry language but preserves an explicit empty value", async () => {
    const absentLanguageFormData = new FormData();
    const emptyLanguageFormData = new FormData();
    const calls: Array<{
      meetingId: string | undefined;
      language: unknown;
    }> = [];

    absentLanguageFormData.set("_intent", "retry-meeting");
    emptyLanguageFormData.set("_intent", "retry-meeting");
    emptyLanguageFormData.set("language", "");

    for (const formData of [absentLanguageFormData, emptyLanguageFormData]) {
      await handleMeetingDetailAction(
        { formData, meetingId },
        {
          retryMeeting: async (input) => {
            calls.push(input);
            return { id: input.meetingId ?? "", resumeFromStage: "diarizing" };
          },
        },
      );
    }

    expect(calls).toEqual([
      { meetingId, language: undefined },
      { meetingId, language: "" },
    ]);
  });

  test("returns retry validation feedback", async () => {
    const formData = new FormData();

    formData.set("_intent", "retry-meeting");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        retryMeeting: async () => {
          throw new MeetingMutationError(
            "This failure cannot be retried.",
            400,
          );
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: {
        ok: false,
        intent: "retry-meeting",
        error: "This failure cannot be retried.",
      },
      status: 400,
    } satisfies MeetingDetailActionResult);
  });

  test("returns friendly feedback when retry queueing fails unexpectedly", async () => {
    const formData = new FormData();

    formData.set("_intent", "retry-meeting");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        retryMeeting: async () => {
          throw new Error("database unavailable");
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: {
        ok: false,
        intent: "retry-meeting",
        error: "Could not queue this retry. Please try again.",
      },
      status: 500,
    } satisfies MeetingDetailActionResult);
  });

  test("saves a speaker mapping through the speaker mapping mutation", async () => {
    const formData = new FormData();
    const calls: Array<{
      meetingId: string | undefined;
      speakerLabel: unknown;
      name: unknown;
    }> = [];

    formData.set("_intent", "save-speaker-mapping");
    formData.set("speakerLabel", "SPEAKER_00");
    formData.set("name", "Atila");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        saveSpeakerMapping: async (input) => {
          calls.push(input);
          return {
            meetingId: input.meetingId ?? "",
            speakerLabel: String(input.speakerLabel),
            name: String(input.name),
          };
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: {
        ok: true,
        intent: "save-speaker-mapping",
        speakerLabel: "SPEAKER_00",
        name: "Atila",
      },
    } satisfies MeetingDetailActionResult);
    expect(calls).toEqual([
      { meetingId, speakerLabel: "SPEAKER_00", name: "Atila" },
    ]);
  });

  test("returns speaker mapping validation feedback with the speaker label", async () => {
    const formData = new FormData();

    formData.set("_intent", "save-speaker-mapping");
    formData.set("speakerLabel", "speaker-00");
    formData.set("name", "Atila");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        saveSpeakerMapping: async () => {
          throw new MeetingMutationError("Choose a valid speaker label.", 400);
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: {
        ok: false,
        intent: "save-speaker-mapping",
        speakerLabel: "speaker-00",
        error: "Choose a valid speaker label.",
      },
      status: 400,
    } satisfies MeetingDetailActionResult);
  });

  test("updates language through the language mutation", async () => {
    const formData = new FormData();
    const calls: Array<{ meetingId: string | undefined; language: unknown }> =
      [];

    formData.set("_intent", "update-language");
    formData.set("language", "auto");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        updateMeetingLanguage: async (input) => {
          calls.push(input);
          return { id: input.meetingId ?? "", language: null };
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: { ok: true, intent: "update-language", language: null },
    } satisfies MeetingDetailActionResult);
    expect(calls).toEqual([{ meetingId, language: "auto" }]);
  });

  test("returns language update validation feedback", async () => {
    const formData = new FormData();

    formData.set("_intent", "update-language");
    formData.set("language", "de");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        updateMeetingLanguage: async () => {
          throw new MeetingMutationError(
            "Choose Serbian, English, or Auto-detect.",
            400,
          );
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: {
        ok: false,
        intent: "update-language",
        error: "Choose Serbian, English, or Auto-detect.",
      },
      status: 400,
    } satisfies MeetingDetailActionResult);
  });

  test("updates the title through the title mutation", async () => {
    const formData = new FormData();
    const calls: Array<{ meetingId: string | undefined; title: unknown }> = [];

    formData.set("_intent", "update-title");
    formData.set("title", "Renamed meeting");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        updateMeetingTitle: async (input) => {
          calls.push(input);
          return { id: input.meetingId ?? "", title: String(input.title) };
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: { ok: true, intent: "update-title", title: "Renamed meeting" },
    } satisfies MeetingDetailActionResult);
    expect(calls).toEqual([{ meetingId, title: "Renamed meeting" }]);
  });

  test("returns validation feedback for invalid title submissions", async () => {
    const formData = new FormData();

    formData.set("_intent", "update-title");
    formData.set("title", "   ");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        updateMeetingTitle: async () => {
          throw new MeetingMutationError("Meeting title cannot be empty.", 400);
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: {
        ok: false,
        intent: "update-title",
        error: "Meeting title cannot be empty.",
      },
      status: 400,
    } satisfies MeetingDetailActionResult);
  });

  test("deletes the meeting and redirects home", async () => {
    const formData = new FormData();
    const deletedMeetingIds: Array<string | undefined> = [];

    formData.set("_intent", "delete-meeting");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        deleteMeetingAndArtifacts: async (input) => {
          deletedMeetingIds.push(input.meetingId);
          return { id: input.meetingId ?? "" };
        },
      },
    );

    expect(result).toEqual({ type: "redirect", to: "/" });
    expect(deletedMeetingIds).toEqual([meetingId]);
  });

  test("returns not found feedback when deletion cannot find the meeting", async () => {
    const formData = new FormData();

    formData.set("_intent", "delete-meeting");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        deleteMeetingAndArtifacts: async () => {
          throw new MeetingMutationError("Meeting not found", 404);
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: { ok: false, intent: "delete-meeting", error: "Meeting not found" },
      status: 404,
    } satisfies MeetingDetailActionResult);
  });

  test("returns friendly feedback when deletion fails unexpectedly", async () => {
    const formData = new FormData();

    formData.set("_intent", "delete-meeting");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        deleteMeetingAndArtifacts: async () => {
          throw new Error("filesystem unavailable");
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: {
        ok: false,
        intent: "delete-meeting",
        error: "Could not delete this meeting. Please try again.",
      },
      status: 500,
    } satisfies MeetingDetailActionResult);
  });

  test("rejects unknown action intents", async () => {
    const formData = new FormData();

    formData.set("_intent", "publish");

    const result = await handleMeetingDetailAction(
      { formData, meetingId },
      {
        deleteMeetingAndArtifacts: async () => {
          throw new Error("unknown intents must not delete");
        },
        updateMeetingTitle: async () => {
          throw new Error("unknown intents must not update");
        },
      },
    );

    expect(result).toEqual({
      type: "data",
      data: {
        ok: false,
        intent: "update-title",
        error: "Choose a valid meeting action.",
      },
      status: 400,
    } satisfies MeetingDetailActionResult);
  });
});
