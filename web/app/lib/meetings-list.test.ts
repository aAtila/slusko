import { describe, expect, test } from "bun:test";
import type { HomeMeetingListItem } from "./meetings-list";
import {
  getMeetingStatusPresentation,
  shouldPollMeetings,
} from "./meetings-list";

function meeting(overrides: Partial<HomeMeetingListItem>): HomeMeetingListItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Weekly Sync",
    status: "done",
    transcriptionProgress: null,
    durationSeconds: null,
    createdAt: "2026-05-05T10:00:00.000Z",
    ...overrides,
  };
}

describe("meeting list status helpers", () => {
  test("does not poll an empty or fully terminal meeting list", () => {
    expect(shouldPollMeetings([])).toBe(false);
    expect(
      shouldPollMeetings([
        meeting({ status: "done" }),
        meeting({ status: "error" }),
      ]),
    ).toBe(false);
  });

  test("polls while any visible meeting is non-terminal", () => {
    for (const status of [
      "pending",
      "normalizing",
      "transcribing",
      "diarizing",
      "summarizing",
    ] as const) {
      expect(shouldPollMeetings([meeting({ status })])).toBe(true);
    }
  });

  test("presents transcription progress only while transcribing", () => {
    expect(
      getMeetingStatusPresentation({
        status: "transcribing",
        transcriptionProgress: 42,
      }),
    ).toMatchObject({ label: "Transcribing 42%", tone: "active" });

    expect(
      getMeetingStatusPresentation({
        status: "transcribing",
        transcriptionProgress: null,
      }),
    ).toMatchObject({ label: "Transcribing", tone: "active" });
  });

  test("presents terminal statuses with terminal tones", () => {
    expect(
      getMeetingStatusPresentation({
        status: "error",
        transcriptionProgress: 82,
      }),
    ).toMatchObject({ label: "Failed", tone: "danger", isTerminal: true });

    expect(
      getMeetingStatusPresentation({
        status: "done",
        transcriptionProgress: 100,
      }),
    ).toMatchObject({ label: "Done", tone: "success", isTerminal: true });
  });
});
