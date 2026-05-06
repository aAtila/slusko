import { describe, expect, test } from "bun:test";
import type { HomeMeetingListItem } from "./meetings-list";
import {
  formatDuration,
  formatTranscriptTimestamp,
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

  test("presents every meeting status with the expected label and terminal state", () => {
    expect(
      getMeetingStatusPresentation({
        status: "pending",
        transcriptionProgress: null,
      }),
    ).toMatchObject({ label: "Queued", isTerminal: false });
    expect(
      getMeetingStatusPresentation({
        status: "normalizing",
        transcriptionProgress: null,
      }),
    ).toMatchObject({ label: "Normalizing audio", isTerminal: false });
    expect(
      getMeetingStatusPresentation({
        status: "transcribing",
        transcriptionProgress: null,
      }),
    ).toMatchObject({ label: "Transcribing", isTerminal: false });
    expect(
      getMeetingStatusPresentation({
        status: "diarizing",
        transcriptionProgress: null,
      }),
    ).toMatchObject({ label: "Identifying speakers", isTerminal: false });
    expect(
      getMeetingStatusPresentation({
        status: "summarizing",
        transcriptionProgress: null,
      }),
    ).toMatchObject({ label: "Summarizing", isTerminal: false });
    expect(
      getMeetingStatusPresentation({
        status: "done",
        transcriptionProgress: null,
      }),
    ).toMatchObject({ label: "Done", isTerminal: true });
    expect(
      getMeetingStatusPresentation({
        status: "error",
        transcriptionProgress: null,
      }),
    ).toMatchObject({ label: "Failed", isTerminal: true });
  });

  test("formats known durations in seconds, minutes, and hours", () => {
    expect(formatDuration(9)).toBe("9s");
    expect(formatDuration(75)).toBe("1m 15s");
    expect(formatDuration(3_905)).toBe("1h 5m");
  });

  test("formats transcript timestamps for sub-hour and hour values", () => {
    expect(formatTranscriptTimestamp(0)).toBe("0:00");
    expect(formatTranscriptTimestamp(75.9)).toBe("1:15");
    expect(formatTranscriptTimestamp(3_905)).toBe("1:05:05");
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
