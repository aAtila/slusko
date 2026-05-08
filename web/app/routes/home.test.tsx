import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { HomeMeetingListItem } from "~/lib/meetings-list";
import { MeetingCard, MeetingRow } from "./home";

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
    ...overrides,
  };
}

function renderWithRouter(children: ReactNode) {
  return renderToStaticMarkup(<MemoryRouter>{children}</MemoryRouter>);
}

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
