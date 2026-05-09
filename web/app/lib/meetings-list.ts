import type {
  ErrorKind,
  MeetingStatus,
  SummaryActionItem,
  SummaryDecision,
  SummaryOpenQuestion,
  SummaryRegenerationStatus,
} from "~/db/schema";

export type MeetingFailureFields = {
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  failedAtStage: MeetingStatus | null;
};

export type HomeMeetingListItem = MeetingFailureFields & {
  id: string;
  title: string;
  status: MeetingStatus;
  transcriptionProgress: number | null;
  durationSeconds: number | null;
  createdAt: string;
};

export type MeetingDetail = HomeMeetingListItem & {
  updatedAt: string;
  summaryRegenerationStatus: SummaryRegenerationStatus;
  summaryRegenerationProcessingStartedAt: string | null;
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

export type MeetingFailurePresentation = {
  isRetryable: boolean;
  message: string;
  retryLabel: string | null;
  retryUnavailableReason: string | null;
  title: string;
};

const retryableFailedStages = new Set<MeetingStatus>([
  "normalizing",
  "transcribing",
  "diarizing",
  "summarizing",
]);

const corruptAudioMessagePatterns = [
  "corrupt",
  "invalid data",
  "could not read",
  "unsupported",
  "no audio stream",
  "failed to decode",
  "moov atom not found",
  "codec not supported",
];

export function isTerminalMeetingStatus(status: MeetingStatus) {
  return status === "done" || status === "error";
}

export function shouldPollMeetings(meetings: HomeMeetingListItem[]) {
  return meetings.some((meeting) => !isTerminalMeetingStatus(meeting.status));
}

export function isRetryableFailedStage(
  failedAtStage: MeetingStatus | null,
): failedAtStage is MeetingStatus {
  return failedAtStage !== null && retryableFailedStages.has(failedAtStage);
}

export function isCorruptAudioNormalizationFailure({
  errorKind,
  errorMessage,
}: {
  errorKind: ErrorKind | null;
  errorMessage: string | null;
}) {
  if (errorKind !== "normalization_failed" || errorMessage === null) {
    return false;
  }

  const normalizedMessage = errorMessage.toLowerCase();

  return corruptAudioMessagePatterns.some((pattern) =>
    normalizedMessage.includes(pattern),
  );
}

export function getMeetingFailurePresentation({
  errorKind,
  errorMessage,
  failedAtStage,
  status,
}: {
  status: MeetingStatus;
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  failedAtStage: MeetingStatus | null;
}): MeetingFailurePresentation | null {
  if (status !== "error") {
    return null;
  }

  const canRetryFromStage = isRetryableFailedStage(failedAtStage);
  const retryUnavailableReason = canRetryFromStage
    ? "This failure cannot be retried."
    : "This meeting did not record a retryable failed stage.";
  const retryLabel = canRetryFromStage
    ? `Retry from ${getFailedStageLabel(failedAtStage)}`
    : null;

  if (isCorruptAudioNormalizationFailure({ errorKind, errorMessage })) {
    return {
      title: "Recording could not be decoded",
      message:
        "The recording could not be decoded. Upload a different audio or video file.",
      isRetryable: false,
      retryLabel: null,
      retryUnavailableReason:
        "This recording cannot be retried because the file appears to be corrupt or unsupported.",
    };
  }

  switch (errorKind) {
    case "normalization_failed":
      return {
        title: "Audio preparation failed",
        message: canRetryFromStage
          ? "Audio preparation failed. Retry to prepare the recording again."
          : "Audio preparation failed before the recording could be prepared.",
        isRetryable: canRetryFromStage,
        retryLabel,
        retryUnavailableReason: canRetryFromStage
          ? null
          : retryUnavailableReason,
      };
    case "transcription_failed":
      return {
        title: "Transcription failed",
        message: canRetryFromStage
          ? "Transcription failed. Retry to run transcription again."
          : "Transcription failed before a retryable stage was recorded.",
        isRetryable: canRetryFromStage,
        retryLabel,
        retryUnavailableReason: canRetryFromStage
          ? null
          : retryUnavailableReason,
      };
    case "transcription_empty":
      return {
        title: "No speech detected",
        message:
          "No speech was detected. Upload a different recording with audible speech.",
        isRetryable: false,
        retryLabel: null,
        retryUnavailableReason:
          "This meeting cannot be retried because no speech was detected.",
      };
    case "diarization_failed":
      return {
        title: "Speaker identification failed",
        message: canRetryFromStage
          ? "Speaker identification failed. Retry to rerun diarization and summarization using the saved transcript."
          : "Speaker identification failed before a retryable stage was recorded.",
        isRetryable: canRetryFromStage,
        retryLabel,
        retryUnavailableReason: canRetryFromStage
          ? null
          : retryUnavailableReason,
      };
    case "summarization_failed":
      return {
        title: "Summary generation failed",
        message: canRetryFromStage
          ? "Summary generation failed. Retry to rerun summarization using the saved transcript."
          : "Summary generation failed before a retryable stage was recorded.",
        isRetryable: canRetryFromStage,
        retryLabel,
        retryUnavailableReason: canRetryFromStage
          ? null
          : retryUnavailableReason,
      };
    case "config_missing":
      return {
        title: "Server configuration missing",
        message:
          "Processing is blocked by missing server configuration. Ask an administrator to configure the worker.",
        isRetryable: false,
        retryLabel: null,
        retryUnavailableReason:
          "This meeting cannot be retried until the missing server configuration is fixed.",
      };
    case "unknown":
    case null:
      return {
        title: "Processing failed unexpectedly",
        message: canRetryFromStage
          ? "Processing failed unexpectedly. Retry from the failed stage."
          : "Processing failed unexpectedly before a retryable stage was recorded.",
        isRetryable: canRetryFromStage,
        retryLabel,
        retryUnavailableReason: canRetryFromStage
          ? null
          : retryUnavailableReason,
      };
    default: {
      const exhaustiveErrorKind: never = errorKind;
      return exhaustiveErrorKind;
    }
  }
}

function getFailedStageLabel(failedAtStage: MeetingStatus) {
  switch (failedAtStage) {
    case "normalizing":
      return "audio preparation";
    case "transcribing":
      return "transcription";
    case "diarizing":
      return "speaker identification";
    case "summarizing":
      return "summarization";
    case "pending":
    case "done":
    case "error":
      return "the failed stage";
    default: {
      const exhaustiveStatus: never = failedAtStage;
      return exhaustiveStatus;
    }
  }
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
