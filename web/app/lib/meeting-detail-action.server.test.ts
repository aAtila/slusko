import { describe, expect, test } from "bun:test";
import {
  handleMeetingDetailAction,
  type MeetingDetailActionResult,
} from "./meeting-detail-action.server";
import { MeetingMutationError } from "./meetings-mutations.server";

const meetingId = "00000000-0000-4000-8000-000000000006";

describe("meeting detail route action", () => {
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
