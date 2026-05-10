import type { IconName } from "~/components/app-icons";
import { formatMeetingLanguageLabel } from "./meeting-language";
import {
  formatDuration,
  getMeetingFailurePresentation,
  getMeetingStatusPresentation,
  type HomeMeetingListItem,
  type MeetingFailurePresentation,
  type MeetingStatusPresentation,
} from "./meetings-list";

export type MeetingListItemIconPresentation = {
  name: IconName;
  palette: string;
  tone: "danger" | "default";
};

export type MeetingListItemPresentation = {
  durationLabel: string;
  failure: MeetingFailurePresentation | null;
  icon: MeetingListItemIconPresentation;
  languageLabel: string;
  statusBadge: MeetingStatusPresentation;
};

const iconPresentations = [
  { name: "users", palette: "bg-brand-soft text-brand" },
  { name: "chart", palette: "bg-accent-soft text-accent-deep" },
  { name: "megaphone", palette: "bg-warning-soft text-warning" },
  { name: "file", palette: "bg-success-soft text-success" },
  { name: "users", palette: "bg-[#e3dde9] text-[#5e4a73]" },
] as const satisfies ReadonlyArray<
  Pick<MeetingListItemIconPresentation, "name" | "palette">
>;

export function getMeetingListItemPresentation(
  meeting: HomeMeetingListItem,
  index: number,
): MeetingListItemPresentation {
  return {
    durationLabel:
      meeting.durationSeconds !== null
        ? formatDuration(meeting.durationSeconds)
        : "Pending",
    failure: getMeetingFailurePresentation(meeting),
    icon: getMeetingListItemIconPresentation(meeting, index),
    languageLabel: formatMeetingLanguageLabel(meeting),
    statusBadge: getMeetingStatusPresentation({
      status: meeting.status,
      transcriptionProgress: meeting.transcriptionProgress,
    }),
  };
}

function getMeetingListItemIconPresentation(
  meeting: HomeMeetingListItem,
  index: number,
): MeetingListItemIconPresentation {
  if (meeting.status === "error") {
    return {
      name: "alert",
      palette: "bg-danger-soft text-danger",
      tone: "danger",
    };
  }

  const iconPresentation = iconPresentations[index % iconPresentations.length];

  return {
    ...iconPresentation,
    tone: "default",
  };
}
