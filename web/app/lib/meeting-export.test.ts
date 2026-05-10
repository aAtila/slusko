import { describe, expect, test } from "bun:test";
import {
  createMeetingExportFilename,
  renderMeetingMarkdownExport,
  renderMeetingPlainTextExport,
  slugifyMeetingTitle,
} from "./meeting-export";
import type {
  MeetingDetail,
  MeetingSummary,
  TranscriptSegment,
} from "./meetings-list";
import type { SpeakerMapping } from "./speaker-display";

type MeetingExportInput = {
  meeting: Pick<MeetingDetail, "title" | "createdAt" | "durationSeconds">;
  summary: MeetingSummary | null;
  transcriptSegments: TranscriptSegment[];
  speakerMappings: SpeakerMapping[];
};

function buildInput(
  overrides: Partial<MeetingExportInput> = {},
): MeetingExportInput {
  return {
    meeting: {
      title: "Weekly Sync",
      createdAt: "2026-05-05T10:00:00.000Z",
      durationSeconds: 75,
    },
    summary: {
      overview: "SPEAKER_00 aligned with SPEAKER_01 on priorities.",
      decisions: [{ text: "SPEAKER_01 owns release timing." }],
      actionItems: [
        {
          task: "SPEAKER_00 prepares the rollout note.",
          owner: { kind: "speaker", value: "SPEAKER_00" },
        },
      ],
      openQuestions: [{ text: "Can SPEAKER_02 join QA review?" }],
      updatedAt: "2026-05-05T11:00:00.000Z",
    },
    transcriptSegments: [
      {
        id: "segment-1",
        startSeconds: 0,
        endSeconds: 4,
        speakerLabel: "SPEAKER_00",
        text: "Kickoff complete.",
      },
    ],
    speakerMappings: [
      { speakerLabel: "SPEAKER_00", name: "Atila" },
      { speakerLabel: "SPEAKER_01", name: "Marko" },
    ],
    ...overrides,
  };
}

describe("renderMeetingMarkdownExport", () => {
  test("renders summary markdown by default as a golden fixture", () => {
    const markdown = renderMeetingMarkdownExport(buildInput());

    expect(markdown).toBe(
      `# Weekly Sync\n\nDate: 2026-05-05\nDuration: 1m 15s\nSpeakers: Atila, Marko, SPEAKER_02\n\n## Overview\n\nAtila aligned with Marko on priorities.\n\n## Decisions\n\n- Marko owns release timing.\n\n## Action items\n\n- [Atila] Atila prepares the rollout note.\n\n## Open questions\n\n- Can SPEAKER_02 join QA review?`,
    );
  });

  test("renders full markdown with transcript section as a golden fixture", () => {
    const markdown = renderMeetingMarkdownExport(buildInput(), "full");

    expect(markdown).toBe(
      `# Weekly Sync\n\nDate: 2026-05-05\nDuration: 1m 15s\nSpeakers: Atila, Marko, SPEAKER_02\n\n## Overview\n\nAtila aligned with Marko on priorities.\n\n## Decisions\n\n- Marko owns release timing.\n\n## Action items\n\n- [Atila] Atila prepares the rollout note.\n\n## Open questions\n\n- Can SPEAKER_02 join QA review?\n\n## Transcript\n\n- [0:00] **Atila:** Kickoff complete.`,
    );
  });

  test("renders empty summary sections when summary is missing", () => {
    const markdown = renderMeetingMarkdownExport(buildInput({ summary: null }));

    expect(markdown).toContain("## Overview\n\n- None recorded.");
    expect(markdown).toContain("## Decisions\n\n- None recorded.");
    expect(markdown).toContain("## Action items\n\n- None recorded.");
    expect(markdown).toContain("## Open questions\n\n- None recorded.");
  });

  test("includes speakers referenced only in summary sections in the export header", () => {
    const markdown = renderMeetingMarkdownExport(
      buildInput({
        summary: {
          overview: "SPEAKER_10 kicked off the rollout.",
          decisions: [{ text: "SPEAKER_11 approves the timeline." }],
          actionItems: [
            {
              owner: { kind: "speaker", value: "SPEAKER_12" },
              task: "SPEAKER_13 sends the follow-up notes.",
            },
          ],
          openQuestions: [],
          updatedAt: "2026-05-05T11:00:00.000Z",
        },
        speakerMappings: [],
        transcriptSegments: [],
      }),
    );

    expect(markdown).toContain(
      "Speakers: SPEAKER_10, SPEAKER_11, SPEAKER_13, SPEAKER_12",
    );
  });
});

describe("meeting export filename and slugification", () => {
  test("builds {iso_date}-{slugified_title}.md filenames", () => {
    expect(createMeetingExportFilename(buildInput())).toBe(
      "2026-05-05-weekly-sync.md",
    );
  });

  test("slugifies Serbian Latin diacritics", () => {
    expect(slugifyMeetingTitle("ČĆŽŠĐ čćžšđ")).toBe("cczsd-cczsd");
  });

  test("slugifies Serbian Cyrillic", () => {
    expect(slugifyMeetingTitle("Љубав и Џез")).toBe("ljubav-i-dzez");
  });

  test("collapses punctuation and falls back to meeting", () => {
    expect(slugifyMeetingTitle("Q2 / Product Strategy")).toBe(
      "q2-product-strategy",
    );
    expect(slugifyMeetingTitle("---")).toBe("meeting");
  });
});

describe("renderMeetingPlainTextExport", () => {
  test("derives plain text from markdown export", () => {
    const text = renderMeetingPlainTextExport(buildInput(), "full");

    expect(text).toContain("Weekly Sync");
    expect(text).toContain("Transcript");
    expect(text).toContain("[0:00] Atila: Kickoff complete.");
    expect(text).not.toContain("# ");
    expect(text).not.toContain("**");
  });
});
