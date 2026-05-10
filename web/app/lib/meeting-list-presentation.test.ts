import { describe, expect, test } from "bun:test";
import { getMeetingListItemPresentation } from "./meeting-list-presentation";
import type { HomeMeetingListItem } from "./meetings-list";

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

describe("meeting list item presentation", () => {
  test("presents done status success with formatted duration", () => {
    expect(
      getMeetingListItemPresentation(
        meeting({ status: "done", durationSeconds: 3_905 }),
        0,
      ),
    ).toMatchObject({
      durationLabel: "1h 5m",
      statusBadge: { label: "Done", tone: "success", isTerminal: true },
    });
  });

  test("presents pending meetings without duration", () => {
    expect(
      getMeetingListItemPresentation(
        meeting({ status: "pending", durationSeconds: null }),
        0,
      ),
    ).toMatchObject({
      durationLabel: "Pending",
      statusBadge: { label: "Queued", tone: "queued", isTerminal: false },
    });
  });

  test("presents transcribing status with progress", () => {
    expect(
      getMeetingListItemPresentation(
        meeting({ status: "transcribing", transcriptionProgress: 42 }),
        0,
      ).statusBadge,
    ).toMatchObject({ label: "Transcribing 42%", tone: "active" });
  });

  test("presents active non-progress stages without duration regression", () => {
    expect(
      getMeetingListItemPresentation(
        meeting({ status: "diarizing", durationSeconds: null }),
        0,
      ),
    ).toMatchObject({
      durationLabel: "Pending",
      statusBadge: { label: "Identifying speakers", tone: "active" },
    });
  });

  test("presents error meetings with failure details and danger tone", () => {
    expect(
      getMeetingListItemPresentation(
        meeting({
          status: "error",
          errorKind: "transcription_failed",
          errorMessage: "Whisper failed",
          failedAtStage: "transcribing",
        }),
        0,
      ),
    ).toMatchObject({
      statusBadge: { label: "Failed", tone: "danger", isTerminal: true },
      failure: {
        title: "Transcription failed",
        message: "Transcription failed. Retry to run transcription again.",
      },
    });
  });

  test("presents requested and auto-detected language labels", () => {
    expect(
      getMeetingListItemPresentation(meeting({ language: "sr" }), 0)
        .languageLabel,
    ).toBe("Serbian");
    expect(
      getMeetingListItemPresentation(meeting({ language: "en" }), 0)
        .languageLabel,
    ).toBe("English");
    expect(
      getMeetingListItemPresentation(
        meeting({ language: null, detectedLanguage: null }),
        0,
      ).languageLabel,
    ).toBe("Auto-detect pending");
    expect(
      getMeetingListItemPresentation(
        meeting({ language: null, detectedLanguage: "hr" }),
        0,
      ).languageLabel,
    ).toBe("Auto-detected Croatian");
  });

  test("presents rotating icons and danger icon for failures", () => {
    expect(getMeetingListItemPresentation(meeting({}), 0).icon).toEqual({
      name: "users",
      palette: "bg-brand-soft text-brand",
      tone: "default",
    });
    expect(getMeetingListItemPresentation(meeting({}), 2).icon).toEqual({
      name: "megaphone",
      palette: "bg-warning-soft text-warning",
      tone: "default",
    });
    expect(
      getMeetingListItemPresentation(meeting({ status: "error" }), 2).icon,
    ).toEqual({
      name: "alert",
      palette: "bg-danger-soft text-danger",
      tone: "danger",
    });
  });
});
