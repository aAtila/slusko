import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeetingStatus } from "~/db/schema";
import type { MeetingSummary, TranscriptSegment } from "~/lib/meetings-list";
import { SummaryPanel, TranscriptPanel } from "./meetings.$meetingId";

function renderTranscriptPanel({
  segments,
  status,
}: {
  segments: TranscriptSegment[];
  status: MeetingStatus;
}) {
  return renderToStaticMarkup(
    <TranscriptPanel segments={segments} status={status} />,
  );
}

function renderSummaryPanel({
  summary,
  status,
}: {
  summary: MeetingSummary | null;
  status: MeetingStatus;
}) {
  return renderToStaticMarkup(
    <SummaryPanel summary={summary} status={status} />,
  );
}

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
