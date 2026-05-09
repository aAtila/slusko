import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { HomeMeetingListItem } from "~/lib/meetings-list";
import { MeetingCard, MeetingRow, UploadDialog, UploadPanel } from "./home";

function meeting(
  overrides: Partial<HomeMeetingListItem> = {},
): HomeMeetingListItem {
  return {
    id: "00000000-0000-4000-8000-000000000015",
    title: "Incident Review",
    status: "error",
    transcriptionProgress: null,
    durationSeconds: 1_200,
    errorKind: "diarization_failed",
    errorMessage: "speaker clustering failed",
    failedAtStage: "diarizing",
    createdAt: "2026-05-05T10:00:00.000Z",
    language: "sr",
    detectedLanguage: null,
    ...overrides,
  };
}

function renderWithRouter(children: ReactNode) {
  return renderToStaticMarkup(<MemoryRouter>{children}</MemoryRouter>);
}

describe("home upload language picker", () => {
  test("drop target explains drag-and-drop uses the Serbian default", () => {
    const markup = renderToStaticMarkup(
      <UploadPanel
        isDraggingRecording={false}
        isUploading={false}
        onBrowseFiles={() => {}}
      />,
    );

    expect(markup).toContain("Dropped files use Serbian by default");
    expect(markup).toContain("browse to choose English or Auto-detect");
  });

  test("upload dialog includes a Serbian-default language field", () => {
    const markup = renderToStaticMarkup(
      <UploadDialog
        isUploading={false}
        selectedFileName={null}
        onCancel={() => {}}
        onFileChange={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(markup).toContain("Transcription language");
    expect(markup).toContain('name="language"');
    expect(markup).toContain('value="sr" selected=""');
    expect(markup).toContain("Serbian");
    expect(markup).toContain("English");
    expect(markup).toContain("Auto-detect");
  });
});

describe("home meeting language presentation", () => {
  test("desktop rows show duration with requested language", () => {
    const markup = renderWithRouter(
      <MeetingRow index={0} meeting={meeting({ status: "done" })} />,
    );

    expect(markup).toContain("20m 00s");
    expect(markup).toContain("Serbian");
  });

  test("mobile cards show pending auto-detect labels", () => {
    const markup = renderWithRouter(
      <MeetingCard
        index={0}
        meeting={meeting({
          durationSeconds: null,
          language: null,
          detectedLanguage: "hr",
        })}
      />,
    );

    expect(markup).toContain("Pending");
    expect(markup).toContain("Auto-detected Croatian");
  });
});

describe("home meeting failure presentation", () => {
  test("desktop rows show error-kind-specific failure copy", () => {
    const markup = renderWithRouter(
      <MeetingRow index={0} meeting={meeting()} />,
    );

    expect(markup).toContain("Incident Review");
    expect(markup).toContain(
      "Speaker identification failed. Retry to rerun diarization and summarization using the saved transcript.",
    );
    expect(markup).toContain("Failed");
  });

  test("mobile cards show non-retryable failure copy without a retry affordance", () => {
    const markup = renderWithRouter(
      <MeetingCard
        index={0}
        meeting={meeting({
          errorKind: "transcription_empty",
          errorMessage: "No speech detected.",
          failedAtStage: "transcribing",
        })}
      />,
    );

    expect(markup).toContain(
      "No speech was detected. Upload a different recording with audible speech.",
    );
    expect(markup).not.toContain("Retry from");
  });

  test("non-error meetings do not show failure copy", () => {
    const markup = renderWithRouter(
      <MeetingRow
        index={0}
        meeting={meeting({
          status: "done",
          errorKind: null,
          errorMessage: null,
          failedAtStage: null,
        })}
      />,
    );

    expect(markup).toContain("Incident Review");
    expect(markup).not.toContain("failed. Retry");
    expect(markup).not.toContain("No speech was detected");
  });
});
