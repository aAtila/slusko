import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeetingStatus } from "~/db/schema";
import type { TranscriptSegment } from "~/lib/meetings-list";
import { TranscriptPanel } from "./meetings.$meetingId";

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
    expect(markup).toContain("Next step.");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("contenteditable");
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
