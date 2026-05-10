import type { SummaryActionItemOwner } from "~/db/schema";

export type SpeakerMapping = {
  speakerLabel: string;
  name: string;
};

export type SpeakerMap = Readonly<Record<string, string | undefined>>;

type SpeakerDisplaySummary = {
  overview: string;
  decisions: Array<{ text: string }>;
  actionItems: Array<{
    task: string;
    owner: SummaryActionItemOwner;
  }>;
  openQuestions: Array<{ text: string }>;
};

type SpeakerDisplayTranscriptSegment = {
  speakerLabel: string;
};

export function createSpeakerMap(mappings: SpeakerMapping[]): SpeakerMap {
  return Object.fromEntries(
    mappings.map((mapping) => [mapping.speakerLabel, mapping.name]),
  );
}

export function applySpeakerMap(text: string, speakerMap: SpeakerMap): string {
  const labels = Object.entries(speakerMap)
    .flatMap(([label, name]) => {
      const trimmedName = name?.trim();

      return trimmedName ? [[label, trimmedName] as const] : [];
    })
    .sort(
      ([firstLabel], [secondLabel]) => secondLabel.length - firstLabel.length,
    );

  if (labels.length === 0) {
    return text;
  }

  const nameByLabel = new Map(labels);
  const labelPattern = labels.map(([label]) => escapeRegExp(label)).join("|");
  const speakerLabelRegex = new RegExp(
    `(?<![A-Za-z0-9_])(${labelPattern})(?![A-Za-z0-9_])`,
    "g",
  );

  return text.replaceAll(
    speakerLabelRegex,
    (speakerLabel) => nameByLabel.get(speakerLabel) ?? speakerLabel,
  );
}

export function formatSpeakerDisplayOwner(
  owner: SummaryActionItemOwner,
  speakerMap: SpeakerMap,
): string {
  switch (owner.kind) {
    case "name":
      return owner.value;
    case "speaker":
      return applySpeakerMap(owner.value, speakerMap);
    case "unknown":
      return "Unassigned";
    default:
      return "Unassigned";
  }
}

export function collectSpeakerLabels({
  speakerMappings,
  summary,
  transcriptSegments,
}: {
  speakerMappings: SpeakerMapping[];
  summary: SpeakerDisplaySummary | null;
  transcriptSegments: SpeakerDisplayTranscriptSegment[];
}): string[] {
  const labels = new Set<string>();

  for (const mapping of speakerMappings) {
    labels.add(mapping.speakerLabel);
  }

  for (const segment of transcriptSegments) {
    labels.add(segment.speakerLabel);
  }

  if (summary !== null) {
    for (const label of extractSpeakerLabels(summary.overview)) {
      labels.add(label);
    }

    for (const decision of summary.decisions) {
      for (const label of extractSpeakerLabels(decision.text)) {
        labels.add(label);
      }
    }

    for (const actionItem of summary.actionItems) {
      for (const label of extractSpeakerLabels(actionItem.task)) {
        labels.add(label);
      }

      if (actionItem.owner.kind === "speaker") {
        labels.add(actionItem.owner.value);
      }
    }

    for (const question of summary.openQuestions) {
      for (const label of extractSpeakerLabels(question.text)) {
        labels.add(label);
      }
    }
  }

  return Array.from(labels);
}

export function formatSpeakerDisplayList({
  labels,
  speakerMap,
}: {
  labels: string[];
  speakerMap: SpeakerMap;
}): string {
  if (labels.length === 0) {
    return "None";
  }

  return labels.map((label) => applySpeakerMap(label, speakerMap)).join(", ");
}

function extractSpeakerLabels(text: string): string[] {
  return text.match(/SPEAKER_\d+/g) ?? [];
}

function escapeRegExp(value: string): string {
  // Canonical regex-metachar escape. Necessary because labels are passed
  // verbatim into `applySpeakerMap`'s dynamic RegExp; a label containing
  // `.`, `(`, `+`, etc. would otherwise produce an invalid pattern or
  // unintended matches. Today's labels are `SPEAKER_##` and don't need
  // escaping in practice, but this keeps the helper safe as a shared util.
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
