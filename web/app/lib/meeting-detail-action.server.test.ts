import { describe, expect, test } from "bun:test";
import {
  handleMeetingDetailAction,
  type MeetingDetailActionResult,
} from "./meeting-detail-action.server";
import { MeetingMutationError } from "./meetings-mutations.server";

const meetingId = "00000000-0000-4000-8000-000000000006";

describe("meeting detail route action", () => {
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
