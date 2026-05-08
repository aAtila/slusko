import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { MeetingStatus } from "~/db/schema";
import type {
  MeetingDetail,
  MeetingSummary,
  SpeakerMap,
  TranscriptSegment,
} from "~/lib/meetings-list";
import {
  ErrorBlock,
  MeetingExportsPanel,
  SummaryPanel,
  TranscriptPanel,
} from "./meetings.$meetingId";

function renderTranscriptPanel({
  segments,
  speakerMap = {},
  status,
}: {
  segments: TranscriptSegment[];
  speakerMap?: SpeakerMap;
  status: MeetingStatus;
}) {
  return renderToStaticMarkup(
    <TranscriptPanel
      segments={segments}
      speakerMap={speakerMap}
      status={status}
    />,
  );
}

function renderSummaryPanel({
  speakerMap = {},
  summary,
  status,
}: {
  speakerMap?: SpeakerMap;
  summary: MeetingSummary | null;
  status: MeetingStatus;
}) {
  return renderToStaticMarkup(
    <SummaryPanel speakerMap={speakerMap} summary={summary} status={status} />,
  );
}

function renderMeetingExportsPanel(
  meetingId = "00000000-0000-4000-8000-000000000123",
) {
  return renderToStaticMarkup(<MeetingExportsPanel meetingId={meetingId} />);
}

function meeting(overrides: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    id: "00000000-0000-4000-8000-000000000123",
    title: "Retry Test",
    status: "error",
    transcriptionProgress: null,
    durationSeconds: 300,
    errorKind: "diarization_failed",
    errorMessage: "speaker clustering failed",
    failedAtStage: "diarizing",
    createdAt: "2026-05-05T10:00:00.000Z",
    updatedAt: "2026-05-05T10:05:00.000Z",
    ...overrides,
  };
}

function renderErrorBlock(props: Parameters<typeof ErrorBlock>[0]) {
  const router = createMemoryRouter(
    [{ path: "/", element: <ErrorBlock {...props} /> }],
    { initialEntries: ["/"] },
  );

  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("MeetingExportsPanel", () => {
  test("renders copy controls and server-backed markdown download links", () => {
    const markup = renderMeetingExportsPanel();

    expect(markup).toContain("Copy summary");
    expect(markup).toContain("Copy full");
    expect(markup).toContain(
      'href="/meetings/00000000-0000-4000-8000-000000000123/exports/summary?download=1"',
    );
    expect(markup).toContain(
      'href="/meetings/00000000-0000-4000-8000-000000000123/exports/full?download=1"',
    );
  });

  test("keeps copy client-side and downloads as server links", () => {
    const source = readFileSync(
      new URL("./meetings.$meetingId.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("fetch(exportPath(flavor))");
    expect(source).toContain("navigator.clipboard.writeText");
    expect(source).toContain("?download=1");
    expect(source).not.toContain("new Blob");
    expect(source).not.toContain('value="copy-summary"');
    expect(source).not.toContain('value="copy-full"');
  });
});

describe("ErrorBlock", () => {
  test("renders retry action for retryable diarization failures", () => {
    const markup = renderErrorBlock({ meeting: meeting() });

    expect(markup).toContain("Speaker identification failed");
    expect(markup).toContain(
      "Speaker identification failed. Retry to rerun diarization and summarization using the saved transcript.",
    );
    expect(markup).toContain('value="retry-meeting"');
    expect(markup).toContain("Retry from speaker identification");
  });

  test("shows queueing label while a retry is submitting", () => {
    const markup = renderErrorBlock({ isRetrying: true, meeting: meeting() });

    expect(markup).toContain("Queueing retry…");
  });

  test("hides retry for non-retryable failure kinds", () => {
    for (const nonRetryableMeeting of [
      meeting({
        errorKind: "transcription_empty",
        errorMessage: "No speech detected.",
        failedAtStage: "transcribing",
      }),
      meeting({
        errorKind: "config_missing",
        errorMessage: "OPENROUTER_API_KEY is missing.",
        failedAtStage: "summarizing",
      }),
      meeting({
        errorKind: "normalization_failed",
        errorMessage: "invalid data found while processing input",
        failedAtStage: "normalizing",
      }),
    ]) {
      const markup = renderErrorBlock({ meeting: nonRetryableMeeting });

      expect(markup).not.toContain('value="retry-meeting"');
      expect(markup).not.toContain("Retry from");
    }
  });

  test("renders retry validation feedback", () => {
    const markup = renderErrorBlock({
      actionData: {
        ok: false,
        intent: "retry-meeting",
        error: "This failure cannot be retried.",
      },
      meeting: meeting(),
    });

    expect(markup).toContain("This failure cannot be retried.");
  });
});

describe("SummaryPanel", () => {
  test("renders overview, decisions, action items, and open questions read-only", () => {
    const markup = renderSummaryPanel({
      status: "done",
      summary: {
        overview: "Team aligned on release readiness.",
        decisions: [{ text: "Ship on Friday." }],
        actionItems: [
          {
            task: "Publish release notes",
            owner: { kind: "name", value: "Atila" },
          },
          {
            task: "Notify stakeholders",
            owner: { kind: "speaker", value: "SPEAKER_01" },
          },
          { task: "Document follow-up", owner: { kind: "unknown" } },
        ],
        openQuestions: [{ text: "Should we include optional migration docs?" }],
        updatedAt: "2026-05-07T20:00:00.000Z",
      },
    });

    expect(markup).toContain("Summary");
    expect(markup).toContain("Overview");
    expect(markup).toContain("Team aligned on release readiness.");
    expect(markup).toContain("Decisions");
    expect(markup).toContain("Ship on Friday.");
    expect(markup).toContain("Action items");
    expect(markup).toContain("Owner: Atila");
    expect(markup).toContain("Owner: SPEAKER_01");
    expect(markup).toContain("Owner: Unassigned");
    expect(markup).toContain("Open questions");
    expect(markup).toContain("Should we include optional migration docs?");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("contenteditable");
  });

  test("applies speaker mappings to rendered summary prose and speaker owners", () => {
    const markup = renderSummaryPanel({
      speakerMap: { SPEAKER_00: "Atila", SPEAKER_01: "Marko" },
      status: "done",
      summary: {
        overview: "SPEAKER_00 aligned with SPEAKER_01.",
        decisions: [{ text: "SPEAKER_01 owns rollout." }],
        actionItems: [
          {
            task: "SPEAKER_00 will publish notes.",
            owner: { kind: "speaker", value: "SPEAKER_00" },
          },
          {
            task: "SPEAKER_02 remains unmapped.",
            owner: { kind: "speaker", value: "SPEAKER_02" },
          },
        ],
        openQuestions: [{ text: "Should SPEAKER_01 invite design?" }],
        updatedAt: "2026-05-07T20:00:00.000Z",
      },
    });

    expect(markup).toContain("Atila aligned with Marko.");
    expect(markup).toContain("Marko owns rollout.");
    expect(markup).toContain("Atila will publish notes.");
    expect(markup).toContain("Owner: Atila");
    expect(markup).toContain("SPEAKER_02 remains unmapped.");
    expect(markup).toContain("Owner: SPEAKER_02");
    expect(markup).toContain("Should Marko invite design?");
  });

  test("renders status-aware empty state copy", () => {
    expect(
      renderSummaryPanel({ summary: null, status: "summarizing" }),
    ).toContain("Summary will appear here after summarization finishes.");
    expect(renderSummaryPanel({ summary: null, status: "error" })).toContain(
      "No summary was saved before processing failed.",
    );
    expect(renderSummaryPanel({ summary: null, status: "done" })).toContain(
      "Summary is not available for this meeting.",
    );
  });
});

describe("Speakers panel markup contract", () => {
  test("keeps blur-save intent hidden fields, no visible per-row save button, and textbox row rendering in source", () => {
    const source = readFileSync(
      new URL("./meetings.$meetingId.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'name="_intent" type="hidden" value="save-speaker-mapping"',
    );
    expect(source).toContain(
      'name="speakerLabel" type="hidden" value={speaker.label}',
    );
    expect(source).toContain("id={`speaker-mapping-${speaker.label}`}");
    expect(source).toContain('type="text"');
    expect(source).not.toContain("Save</button>");
  });
});

describe("TranscriptPanel", () => {
  test("renders timestamped transcript rows as read-only content", () => {
    const markup = renderTranscriptPanel({
      status: "done",
      segments: [
        {
          id: "00000000-0000-4000-8000-00000000a111",
          startSeconds: 0,
          endSeconds: 2,
          speakerLabel: "SPEAKER_00",
          text: "Kickoff.",
        },
        {
          id: "00000000-0000-4000-8000-00000000a112",
          startSeconds: 75.9,
          endSeconds: 78,
          speakerLabel: "SPEAKER_01",
          text: "Next step.",
        },
      ],
    });

    expect(markup).toContain("Transcript");
    expect(markup).toContain("[0:00]");
    expect(markup).toContain("[1:15]");
    expect(markup).toContain("SPEAKER_00");
    expect(markup).toContain("SPEAKER_01");
    expect(markup).toContain("Next step.");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("contenteditable");
  });

  test("applies speaker mappings to transcript display names", () => {
    const markup = renderTranscriptPanel({
      speakerMap: { SPEAKER_00: "Atila" },
      status: "done",
      segments: [
        {
          id: "00000000-0000-4000-8000-00000000a114",
          startSeconds: 0,
          endSeconds: 2,
          speakerLabel: "SPEAKER_00",
          text: "Mapped row.",
        },
        {
          id: "00000000-0000-4000-8000-00000000a115",
          startSeconds: 3,
          endSeconds: 5,
          speakerLabel: "SPEAKER_01",
          text: "Unmapped row.",
        },
      ],
    });

    expect(markup).toContain("Atila");
    expect(markup).toContain("SPEAKER_01");
    expect(markup).not.toContain("Speaker 1");
  });

  test("keeps transcript rows visible while diarizing", () => {
    const markup = renderTranscriptPanel({
      status: "diarizing",
      segments: [
        {
          id: "00000000-0000-4000-8000-00000000a113",
          startSeconds: 12,
          endSeconds: 16,
          speakerLabel: "SPEAKER_01",
          text: "Diarization can continue while rows remain visible.",
        },
      ],
    });

    expect(markup).toContain("SPEAKER_01");
    expect(markup).toContain(
      "Diarization can continue while rows remain visible.",
    );
    expect(markup).not.toContain("Transcript will appear here");
    expect(markup).not.toContain("Map speaker");
    expect(markup).not.toContain("speaker mapping");
    expect(markup).not.toContain("<select");
  });

  test("renders status-aware empty state copy", () => {
    expect(
      renderTranscriptPanel({ segments: [], status: "transcribing" }),
    ).toContain("Transcript will appear here when transcription finishes.");
    expect(renderTranscriptPanel({ segments: [], status: "error" })).toContain(
      "No transcript was saved before processing failed.",
    );
    expect(renderTranscriptPanel({ segments: [], status: "done" })).toContain(
      "Transcript is not available for this meeting.",
    );
  });
});
