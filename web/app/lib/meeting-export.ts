import type {
  MeetingDetail,
  MeetingSummary,
  TranscriptSegment,
} from "./meetings-list";
import { formatDuration, formatTranscriptTimestamp } from "./meetings-list";
import type { SpeakerMapping } from "./speaker-display";
import {
  applySpeakerMap,
  collectSpeakerLabels,
  createSpeakerMap,
  formatSpeakerDisplayList,
  formatSpeakerDisplayOwner,
} from "./speaker-display";

export type MeetingExportFlavor = "summary" | "full";

export type MeetingExportInput = {
  meeting: Pick<MeetingDetail, "title" | "createdAt" | "durationSeconds">;
  summary: MeetingSummary | null;
  transcriptSegments: TranscriptSegment[];
  speakerMappings: SpeakerMapping[];
};

export function renderMeetingMarkdownExport(
  input: MeetingExportInput,
  flavor: MeetingExportFlavor = "summary",
): string {
  const speakerMap = createSpeakerMap(input.speakerMappings);
  const summary = input.summary;
  const speakerLabels = collectSpeakerLabels({
    speakerMappings: input.speakerMappings,
    summary: input.summary,
    transcriptSegments: input.transcriptSegments,
  });

  const sections = [
    `# ${input.meeting.title}`,
    "",
    `Date: ${input.meeting.createdAt.slice(0, 10)}`,
    `Duration: ${
      input.meeting.durationSeconds === null
        ? "Not available"
        : formatDuration(input.meeting.durationSeconds)
    }`,
    `Speakers: ${formatSpeakerDisplayList({
      labels: speakerLabels,
      speakerMap,
    })}`,
    "",
    "## Overview",
    "",
    applySpeakerMap(summary?.overview ?? "", speakerMap) || "- None recorded.",
    "",
    "## Decisions",
    "",
    formatBulletList(
      (summary?.decisions ?? []).map((decision) =>
        applySpeakerMap(decision.text, speakerMap),
      ),
    ),
    "",
    "## Action items",
    "",
    formatBulletList(
      (summary?.actionItems ?? []).map((item) => {
        const owner = formatSpeakerDisplayOwner(item.owner, speakerMap);
        const task = applySpeakerMap(item.task, speakerMap);
        return `[${owner}] ${task}`;
      }),
    ),
    "",
    "## Open questions",
    "",
    formatBulletList(
      (summary?.openQuestions ?? []).map((question) =>
        applySpeakerMap(question.text, speakerMap),
      ),
    ),
  ];

  if (flavor === "full") {
    sections.push(
      "",
      "## Transcript",
      "",
      formatBulletList(
        input.transcriptSegments.map((segment) => {
          const speaker =
            applySpeakerMap(segment.speakerLabel, speakerMap) ||
            segment.speakerLabel;
          return `[${formatTranscriptTimestamp(segment.startSeconds)}] **${speaker}:** ${applySpeakerMap(segment.text, speakerMap)}`;
        }),
      ),
    );
  }

  return sections.join("\n");
}

export function renderMeetingPlainTextExport(
  input: MeetingExportInput,
  flavor: MeetingExportFlavor = "summary",
): string {
  return markdownToPlainText(renderMeetingMarkdownExport(input, flavor));
}

export function createMeetingExportFilename(input: MeetingExportInput): string {
  const isoDate = input.meeting.createdAt.slice(0, 10);
  return `${isoDate}-${slugifyMeetingTitle(input.meeting.title)}.md`;
}

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  ђ: "dj",
  е: "e",
  ж: "z",
  з: "z",
  и: "i",
  ј: "j",
  к: "k",
  л: "l",
  љ: "lj",
  м: "m",
  н: "n",
  њ: "nj",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  ћ: "c",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "c",
  џ: "dz",
  ш: "s",
};

const LATIN_DIACRITICS: Record<string, string> = {
  č: "c",
  ć: "c",
  ž: "z",
  š: "s",
  đ: "d",
};

export function slugifyMeetingTitle(title: string): string {
  const lowered = title.toLowerCase();
  const transliterated = Array.from(lowered, (character) => {
    if (CYRILLIC_TO_LATIN[character]) {
      return CYRILLIC_TO_LATIN[character];
    }

    if (LATIN_DIACRITICS[character]) {
      return LATIN_DIACRITICS[character];
    }

    return character;
  }).join("");

  const slug = transliterated
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "meeting";
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/^-\s+/gm, "")
    .trim();
}

function formatBulletList(items: string[]): string {
  if (items.length === 0) {
    return "- None recorded.";
  }

  return items.map((item) => `- ${item}`).join("\n");
}
