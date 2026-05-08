import type {
  ErrorKind,
  MeetingStatus,
  SummaryActionItem,
  SummaryDecision,
  SummaryOpenQuestion,
} from "~/db/schema";

export type HomeMeetingListItem = {
  id: string;
  title: string;
  status: MeetingStatus;
  transcriptionProgress: number | null;
  durationSeconds: number | null;
  createdAt: string;
};

export type MeetingDetail = HomeMeetingListItem & {
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  failedAtStage: MeetingStatus | null;
  updatedAt: string;
};

export type TranscriptSegment = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  speakerLabel: string;
  text: string;
};

export type MeetingSummary = {
  overview: string;
  decisions: SummaryDecision[];
  actionItems: SummaryActionItem[];
  openQuestions: SummaryOpenQuestion[];
  updatedAt: string;
};

export type SpeakerMapping = {
  speakerLabel: string;
  name: string;
};

export type SpeakerMap = Readonly<Record<string, string | undefined>>;

export type MeetingDetailRouteData = {
  meeting: MeetingDetail;
  summary: MeetingSummary | null;
  transcriptSegments: TranscriptSegment[];
  speakerMappings: SpeakerMapping[];
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

function escapeRegExp(value: string) {
  const escapedCharacters = new Set([
    "\\",
    ".",
    "*",
    "+",
    "?",
    "^",
    "$",
    "{",
    "}",
    "(",
    ")",
    "|",
    "[",
    "]",
  ]);

  return Array.from(value, (character) =>
    escapedCharacters.has(character) ? `\${character}` : character,
  ).join("");
}

export type MeetingStatusTone = "active" | "danger" | "queued" | "success";

export type MeetingStatusPresentation = {
  isTerminal: boolean;
  label: string;
  tone: MeetingStatusTone;
};

export function isTerminalMeetingStatus(status: MeetingStatus) {
  return status === "done" || status === "error";
}

export function shouldPollMeetings(meetings: HomeMeetingListItem[]) {
  return meetings.some((meeting) => !isTerminalMeetingStatus(meeting.status));
}

export function formatDuration(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const roundedSeconds = Math.ceil(safeSeconds);
  const hours = Math.floor(roundedSeconds / 3_600);
  const minutes = Math.floor((roundedSeconds % 3_600) / 60);
  const remainingSeconds = roundedSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
  }

  return `${remainingSeconds}s`;
}

export function formatTranscriptTimestamp(seconds: number) {
  const safeSeconds = Number.isFinite(seconds)
    ? Math.max(0, Math.floor(seconds))
    : 0;
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  }

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function getMeetingStatusPresentation({
  status,
  transcriptionProgress,
}: {
  status: MeetingStatus;
  transcriptionProgress: number | null;
}): MeetingStatusPresentation {
  switch (status) {
    case "pending":
      return { isTerminal: false, label: "Queued", tone: "queued" };
    case "normalizing":
      return {
        isTerminal: false,
        label: "Normalizing audio",
        tone: "active",
      };
    case "transcribing":
      return {
        isTerminal: false,
        label:
          transcriptionProgress === null
            ? "Transcribing"
            : `Transcribing ${transcriptionProgress}%`,
        tone: "active",
      };
    case "diarizing":
      return {
        isTerminal: false,
        label: "Identifying speakers",
        tone: "active",
      };
    case "summarizing":
      return { isTerminal: false, label: "Summarizing", tone: "active" };
    case "done":
      return { isTerminal: true, label: "Done", tone: "success" };
    case "error":
      return { isTerminal: true, label: "Failed", tone: "danger" };
    default: {
      const exhaustiveStatus: never = status;
      return exhaustiveStatus;
    }
  }
}
