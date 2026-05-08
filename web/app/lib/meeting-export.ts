import type {
  MeetingDetail,
  MeetingSummary,
  SpeakerMapping,
  TranscriptSegment,
} from "./meetings-list";
import {
  applySpeakerMap,
  createSpeakerMap,
  formatDuration,
  formatTranscriptTimestamp,
} from "./meetings-list";

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

  const sections = [
    `# ${input.meeting.title}`,
    "",
    `Date: ${input.meeting.createdAt.slice(0, 10)}`,
    `Duration: ${
      input.meeting.durationSeconds === null
        ? "Not available"
        : formatDuration(input.meeting.durationSeconds)
    }`,
    `Speakers: ${formatSpeakers(input, speakerMap)}`,
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
        const owner = formatActionItemOwner(item.owner, speakerMap);
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

function formatActionItemOwner(
  owner: MeetingSummary["actionItems"][number]["owner"],
  speakerMap: ReturnType<typeof createSpeakerMap>,
): string {
  switch (owner.kind) {
    case "name":
      return owner.value;
    case "speaker":
      return applySpeakerMap(owner.value, speakerMap);
    case "unknown":
      return "Unassigned";
    default: {
      const exhaustive: never = owner;
      return exhaustive;
    }
  }
}

function formatSpeakers(
  input: MeetingExportInput,
  speakerMap: ReturnType<typeof createSpeakerMap>,
): string {
  const labels = new Set<string>();

  for (const mapping of input.speakerMappings) {
    labels.add(mapping.speakerLabel);
  }

  for (const segment of input.transcriptSegments) {
    labels.add(segment.speakerLabel);
  }

  if (input.summary !== null) {
    for (const label of extractSpeakerLabels(input.summary.overview)) {
      labels.add(label);
    }

    for (const decision of input.summary.decisions) {
      for (const label of extractSpeakerLabels(decision.text)) {
        labels.add(label);
      }
    }

    for (const actionItem of input.summary.actionItems) {
      for (const label of extractSpeakerLabels(actionItem.task)) {
        labels.add(label);
      }

      if (actionItem.owner.kind === "speaker") {
        labels.add(actionItem.owner.value);
      }
    }

    for (const question of input.summary.openQuestions) {
      for (const label of extractSpeakerLabels(question.text)) {
        labels.add(label);
      }
    }
  }

  const values = Array.from(labels).map((label) =>
    applySpeakerMap(label, speakerMap),
  );
  return values.length === 0 ? "None" : values.join(", ");
}

function extractSpeakerLabels(text: string): string[] {
  return text.match(/SPEAKER_\d+/g) ?? [];
}
