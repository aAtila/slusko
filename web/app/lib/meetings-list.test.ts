import { describe, expect, test } from "bun:test";
import {
  formatMeetingLanguageLabel,
  formatRequestedLanguageLabel,
} from "./meeting-language";
import type { HomeMeetingListItem } from "./meetings-list";
import {
  formatDuration,
  formatTranscriptTimestamp,
  getMeetingFailurePresentation,
  getMeetingStatusPresentation,
  isCorruptAudioNormalizationFailure,
  shouldPollMeetings,
} from "./meetings-list";

function meeting(overrides: Partial<HomeMeetingListItem>): HomeMeetingListItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Weekly Sync",
    status: "done",
    transcriptionProgress: null,
    durationSeconds: null,
    errorKind: null,
    errorMessage: null,
    failedAtStage: null,
    createdAt: "2026-05-05T10:00:00.000Z",
    language: "sr",
    detectedLanguage: null,
    ...overrides,
  };
}

describe("meeting failure presentation helpers", () => {
  test("returns no failure presentation for non-error meetings", () => {
    expect(
      getMeetingFailurePresentation(meeting({ status: "done" })),
    ).toBeNull();
  });

  test("marks transient normalization failures retryable", () => {
    expect(
      getMeetingFailurePresentation(
        meeting({
          status: "error",
          errorKind: "normalization_failed",
          errorMessage: "ffmpeg timed out while preparing audio",
          failedAtStage: "normalizing",
        }),
      ),
    ).toMatchObject({
      title: "Audio preparation failed",
      message:
        "Audio preparation failed. Retry to prepare the recording again.",
      isRetryable: true,
      retryLabel: "Retry from audio preparation",
    });
  });

  test("hides retry for corrupt-audio-shaped normalization failures", () => {
    expect(
      isCorruptAudioNormalizationFailure({
        errorKind: "normalization_failed",
        errorMessage: "moov atom not found while decoding upload.mp4",
      }),
    ).toBe(true);

    expect(
      getMeetingFailurePresentation(
        meeting({
          status: "error",
          errorKind: "normalization_failed",
          errorMessage: "moov atom not found while decoding upload.mp4",
          failedAtStage: "normalizing",
        }),
      ),
    ).toMatchObject({
      title: "Recording could not be decoded",
      isRetryable: false,
      retryLabel: null,
    });
  });

  test("hides retry for transcription-empty and config-missing failures", () => {
    expect(
      getMeetingFailurePresentation(
        meeting({
          status: "error",
          errorKind: "transcription_empty",
          errorMessage: "No speech detected.",
          failedAtStage: "transcribing",
        }),
      ),
    ).toMatchObject({
      message:
        "No speech was detected. Upload a different recording with audible speech.",
      isRetryable: false,
    });

    expect(
      getMeetingFailurePresentation(
        meeting({
          status: "error",
          errorKind: "config_missing",
          errorMessage: "OPENROUTER_API_KEY is missing.",
          failedAtStage: "summarizing",
        }),
      ),
    ).toMatchObject({
      message:
        "Processing is blocked by missing server configuration. Ask an administrator to configure the worker.",
      isRetryable: false,
    });
  });

  test("marks diarization and summarization failures retryable from their failed stages", () => {
    expect(
      getMeetingFailurePresentation(
        meeting({
          status: "error",
          errorKind: "diarization_failed",
          errorMessage: "speaker clustering failed",
          failedAtStage: "diarizing",
        }),
      ),
    ).toMatchObject({
      title: "Speaker identification failed",
      isRetryable: true,
      retryLabel: "Retry from speaker identification",
    });

    expect(
      getMeetingFailurePresentation(
        meeting({
          status: "error",
          errorKind: "summarization_failed",
          errorMessage: "LLM request failed",
          failedAtStage: "summarizing",
        }),
      ),
    ).toMatchObject({
      title: "Summary generation failed",
      isRetryable: true,
      retryLabel: "Retry from summarization",
    });
  });

  test("requires a retryable failed stage before showing retry", () => {
    const missingStagePresentation = getMeetingFailurePresentation(
      meeting({
        status: "error",
        errorKind: "diarization_failed",
        errorMessage: "unexpected",
        failedAtStage: null,
      }),
    );

    expect(missingStagePresentation).toMatchObject({
      isRetryable: false,
      retryLabel: null,
    });
    expect(missingStagePresentation?.message).not.toContain("Retry");

    expect(
      getMeetingFailurePresentation(
        meeting({
          status: "error",
          errorKind: "unknown",
          errorMessage: "unexpected",
          failedAtStage: "error",
        }),
      ),
    ).toMatchObject({ isRetryable: false, retryLabel: null });
  });
});

describe("meeting language presentation helpers", () => {
  test("formats requested language choices", () => {
    expect(formatRequestedLanguageLabel("sr")).toBe("Serbian");
    expect(formatRequestedLanguageLabel("en")).toBe("English");
    expect(formatRequestedLanguageLabel(null)).toBe("Auto-detect");
  });

  test("formats resolved language labels for meeting lists and details", () => {
    expect(formatMeetingLanguageLabel(meeting({ language: "sr" }))).toBe(
      "Serbian",
    );
    expect(formatMeetingLanguageLabel(meeting({ language: "en" }))).toBe(
      "English",
    );
    expect(formatMeetingLanguageLabel(meeting({ language: null }))).toBe(
      "Auto-detect pending",
    );
    expect(
      formatMeetingLanguageLabel(
        meeting({ language: null, detectedLanguage: "hr" }),
      ),
    ).toBe("Auto-detected Croatian");
    expect(
      formatMeetingLanguageLabel(
        meeting({ language: null, detectedLanguage: "de" }),
      ),
    ).toBe("Auto-detected DE");
  });
});

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

  test("rounds fractional durations up to whole seconds", () => {
    expect(formatDuration(55.85999999999999)).toBe("56s");
    expect(formatDuration(193.02000000000004)).toBe("3m 14s");
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
