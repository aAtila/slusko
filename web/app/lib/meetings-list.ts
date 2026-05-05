import type { MeetingStatus } from "~/db/schema";

export type HomeMeetingListItem = {
  id: string;
  title: string;
  status: MeetingStatus;
  transcriptionProgress: number | null;
  durationSeconds: number | null;
  createdAt: string;
};

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
