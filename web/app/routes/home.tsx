import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { data, Link, useFetcher } from "react-router";
import { Icon, type IconName } from "~/components/app-icons";
import { useAppShellChrome, type AppShellChrome } from "~/components/app-shell";
import type { MeetingStatus } from "~/db/schema";
import {
  formatDuration,
  getMeetingStatusPresentation,
  shouldPollMeetings,
  type HomeMeetingListItem,
  type MeetingStatusTone,
} from "~/lib/meetings-list";
import { formatRelativeTimeFromNow } from "~/lib/relative-time";
import type { Route } from "./+types/home";

const acceptedRecordingExtensions = [".mp3", ".m4a", ".wav", ".mp4"] as const;
const acceptedRecordingTypes = acceptedRecordingExtensions.join(",");
const homeMeetingsQueryKey = ["home-meetings"] as const;

type HomeMeetingsResponse = {
  meetings: HomeMeetingListItem[];
};

type UploadActionData =
  | { ok: true; meetingId: string }
  | { ok: false; error: string };

type DateFilter = "all" | "last-7" | "last-30";
type MeetingStatusFilter = "all" | "active" | "done" | "error";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Meetings - Slusko" },
    {
      name: "description",
      content: "Upload, transcribe, and summarize internal meetings.",
    },
  ];
}

export async function loader() {
  const { loadHomeMeetings } = await import("~/lib/meetings-list.server");

  return {
    meetings: await loadHomeMeetings(),
  } satisfies HomeMeetingsResponse;
}

export async function action({ request }: Route.ActionArgs) {
  const { createPendingMeetingFromUpload, isMeetingUploadError } =
    await import("~/lib/meetings-upload.server");

  try {
    const meeting = await createPendingMeetingFromUpload(request);

    return {
      ok: true,
      meetingId: meeting.id,
    } satisfies UploadActionData;
  } catch (error) {
    if (isMeetingUploadError(error)) {
      return data(
        {
          ok: false,
          error: error.message,
        } satisfies UploadActionData,
        { status: error.status },
      );
    }

    return data(
      {
        ok: false,
        error:
          "Upload failed before the meeting could be queued. Please try again.",
      } satisfies UploadActionData,
      { status: 500 },
    );
  }
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const queryClient = useQueryClient();
  const fetcher = useFetcher<UploadActionData>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [isDraggingRecording, setIsDraggingRecording] = useState(false);
  const [dateFilter, setDateFilter] = useState<DateFilter>("last-30");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<MeetingStatusFilter>("all");
  const isUploading = fetcher.state !== "idle";
  const actionError = fetcher.data?.ok === false ? fetcher.data.error : null;
  const uploadError = clientError ?? actionError;
  const meetingsQuery = useQuery({
    initialData: { meetings: loaderData.meetings },
    queryFn: fetchHomeMeetings,
    queryKey: homeMeetingsQueryKey,
    refetchInterval: (query) =>
      shouldPollMeetings(query.state.data?.meetings ?? []) ? 5_000 : false,
  });
  const meetings = meetingsQuery.data.meetings;
  const filteredMeetings = useMemo(
    () => filterMeetings({ dateFilter, meetings, searchTerm, statusFilter }),
    [dateFilter, meetings, searchTerm, statusFilter],
  );
  const completedMeetingsCount = meetings.filter(
    (meeting) => meeting.status === "done",
  ).length;
  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  useEffect(() => {
    queryClient.setQueryData<HomeMeetingsResponse>(homeMeetingsQueryKey, {
      meetings: loaderData.meetings,
    });
  }, [loaderData.meetings, queryClient]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok === true) {
      void queryClient.invalidateQueries({ queryKey: homeMeetingsQueryKey });
    }
  }, [fetcher.data, fetcher.state, queryClient]);

  const submitRecording = useCallback(
    (file: File | null | undefined) => {
      if (isUploading) {
        setClientError("Wait for the current upload to finish.");
        return;
      }

      const validationError = validateRecordingFile(file);
      if (validationError !== null || !file) {
        setClientError(validationError);
        return;
      }

      setClientError(null);
      const formData = new FormData();
      formData.append("recording", file);
      fetcher.submit(formData, {
        encType: "multipart/form-data",
        method: "post",
      });
    },
    [fetcher, isUploading],
  );
  const shellChrome = useMemo<AppShellChrome>(
    () => ({
      dropZone: {
        onDragEnter: (event) => {
          event.preventDefault();
          setIsDraggingRecording(true);
        },
        onDragLeave: (event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setIsDraggingRecording(false);
          }
        },
        onDragOver: (event) => {
          event.preventDefault();
        },
        onDrop: (event) => {
          event.preventDefault();
          setIsDraggingRecording(false);

          if (event.dataTransfer.files.length !== 1) {
            setClientError("Upload one recording file at a time.");
            return;
          }

          submitRecording(event.dataTransfer.files.item(0));
        },
      },
      primaryAction: {
        kind: "button" as const,
        label: isUploading ? "Uploading..." : "New Meeting",
        ariaLabel: isUploading ? "Uploading meeting" : "New Meeting",
        disabled: isUploading,
        onClick: openFilePicker,
      },
      storage: {
        description: `${completedMeetingsCount} processed / ${meetings.length} meetings`,
        percentage: 28,
        percentageLabel: "28%",
      },
    }),
    [
      completedMeetingsCount,
      isUploading,
      meetings.length,
      openFilePicker,
      submitRecording,
    ],
  );

  useAppShellChrome(shellChrome);

  return (
    <section className="flex min-w-0 flex-1 flex-col px-4 py-5 sm:px-6 md:px-8 lg:px-10 lg:py-11">
      <input
        accept={acceptedRecordingTypes}
        className="sr-only"
        disabled={isUploading}
        onChange={(event) => {
          submitRecording(event.currentTarget.files?.item(0));
          event.currentTarget.value = "";
        }}
        ref={fileInputRef}
        type="file"
      />
      <header className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-normal text-[#10142f] sm:text-4xl">
            Meetings
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#697391] sm:text-base">
            Upload, review, and manage meeting transcripts
          </p>
        </div>
        <button
          className="hidden h-12 items-center justify-center gap-2 rounded-lg bg-[#5947f5] px-6 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(89,71,245,0.22)] transition hover:bg-[#4938dc] disabled:cursor-not-allowed disabled:opacity-60 md:inline-flex"
          disabled={isUploading}
          onClick={openFilePicker}
          type="button"
        >
          <Icon name="plus" className="size-5" />
          {isUploading ? "Uploading..." : "New Meeting"}
        </button>
      </header>

      {uploadError ? (
        <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {uploadError}
        </p>
      ) : null}

      <UploadPanel
        isDraggingRecording={isDraggingRecording}
        isUploading={isUploading}
        onBrowseFiles={openFilePicker}
      />
      <MeetingsToolbar
        dateFilter={dateFilter}
        searchTerm={searchTerm}
        statusFilter={statusFilter}
        onDateFilterChange={setDateFilter}
        onSearchTermChange={setSearchTerm}
        onStatusFilterChange={setStatusFilter}
      />

      {meetings.length === 0 ? (
        <EmptyMeetings isUploading={isUploading} />
      ) : (
        <MeetingList
          meetings={filteredMeetings}
          totalMeetings={meetings.length}
        />
      )}
    </section>
  );
}

function UploadPanel({
  isDraggingRecording,
  isUploading,
  onBrowseFiles,
}: {
  isDraggingRecording: boolean;
  isUploading: boolean;
  onBrowseFiles: () => void;
}) {
  return (
    <div
      className={`mt-8 rounded-2xl border border-dashed px-5 py-10 text-center transition sm:px-8 sm:py-12 ${
        isDraggingRecording
          ? "border-[#5947f5] bg-[#f5f3ff]"
          : "border-[#cbc5ff] bg-white"
      }`}
    >
      <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-[#f2f0ff] text-[#5947f5]">
        <Icon name="upload-cloud" className="size-7" />
      </div>
      <h2 className="mt-5 text-lg font-semibold text-[#151936]">
        Drop audio or video files here
      </h2>
      <p className="mt-2 text-sm leading-6 text-[#697391]">
        Supports MP3, WAV, M4A, MP4 and more (max 2 GB)
      </p>
      <button
        className="mt-4 inline-flex h-12 items-center justify-center gap-2 rounded-lg border border-[#dfe4ef] bg-white px-6 text-sm font-semibold text-[#151936] shadow-sm transition hover:border-[#cbc5ff] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isUploading}
        onClick={onBrowseFiles}
        type="button"
      >
        <Icon name="folder" className="size-5 text-[#66718c]" />
        {isUploading ? "Uploading..." : "Browse files"}
      </button>
    </div>
  );
}

function MeetingsToolbar({
  dateFilter,
  searchTerm,
  statusFilter,
  onDateFilterChange,
  onSearchTermChange,
  onStatusFilterChange,
}: {
  dateFilter: DateFilter;
  searchTerm: string;
  statusFilter: MeetingStatusFilter;
  onDateFilterChange: (value: DateFilter) => void;
  onSearchTermChange: (value: string) => void;
  onStatusFilterChange: (value: MeetingStatusFilter) => void;
}) {
  const hasActiveFilter =
    dateFilter !== "last-30" || searchTerm.length > 0 || statusFilter !== "all";

  return (
    <div className="mt-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div className="flex flex-col gap-3 sm:flex-row" id="meetings-search">
        <label className="sr-only" htmlFor="status-filter">
          Filter meetings
        </label>
        <div className="relative">
          <select
            className="h-11 w-full appearance-none rounded-lg border border-[#dfe4ef] bg-white px-4 pr-10 text-sm font-medium text-[#151936] transition outline-none focus:border-[#5947f5] sm:w-40"
            id="status-filter"
            onChange={(event) =>
              onStatusFilterChange(
                event.currentTarget.value as MeetingStatusFilter,
              )
            }
            value={statusFilter}
          >
            <option value="all">All meetings</option>
            <option value="active">Active</option>
            <option value="done">Processed</option>
            <option value="error">Failed</option>
          </select>
          <Icon
            name="chevron-down"
            className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-[#66718c]"
          />
        </div>
        <label className="sr-only" htmlFor="date-filter">
          Filter by upload date
        </label>
        <div className="relative">
          <Icon
            name="calendar"
            className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-[#66718c]"
          />
          <select
            className="h-11 w-full appearance-none rounded-lg border border-[#dfe4ef] bg-white pr-10 pl-10 text-sm font-medium text-[#151936] transition outline-none focus:border-[#5947f5] sm:w-44"
            id="date-filter"
            onChange={(event) =>
              onDateFilterChange(event.currentTarget.value as DateFilter)
            }
            value={dateFilter}
          >
            <option value="last-30">Last 30 days</option>
            <option value="last-7">Last 7 days</option>
            <option value="all">All time</option>
          </select>
          <Icon
            name="chevron-down"
            className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-[#66718c]"
          />
        </div>
      </div>
      <div className="flex gap-3">
        <label
          className="relative min-w-0 flex-1 md:w-[296px] md:flex-none"
          htmlFor="meeting-search"
        >
          <span className="sr-only">Search meetings</span>
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-[#66718c]"
          />
          <input
            className="h-11 w-full rounded-lg border border-[#dfe4ef] bg-white pr-4 pl-12 text-sm text-[#151936] transition outline-none placeholder:text-[#9aa2b8] focus:border-[#5947f5]"
            id="meeting-search"
            onChange={(event) => onSearchTermChange(event.currentTarget.value)}
            placeholder="Search meetings..."
            type="search"
            value={searchTerm}
          />
        </label>
        <button
          aria-label="Reset filters"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-[#dfe4ef] text-[#66718c] disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!hasActiveFilter}
          onClick={() => {
            onDateFilterChange("last-30");
            onSearchTermChange("");
            onStatusFilterChange("all");
          }}
          type="button"
        >
          <Icon name="sliders" className="size-5" />
        </button>
      </div>
    </div>
  );
}

function EmptyMeetings({ isUploading }: { isUploading: boolean }) {
  return (
    <div className="mt-5 flex min-h-80 w-full flex-col items-center justify-center rounded-2xl border border-[#edf0f7] bg-white px-6 py-16 text-center shadow-[0_12px_35px_rgba(17,24,39,0.04)]">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-[#f2f0ff] text-[#5947f5]">
        <Icon name="upload-cloud" className="size-7" />
      </div>
      <h2 className="mt-6 text-2xl font-semibold">No meetings yet</h2>
      <p className="mt-3 max-w-md text-sm leading-6 text-[#697391]">
        {isUploading
          ? "Uploading your recording and queueing the meeting..."
          : "Drag and drop an audio or video recording here, or use New Meeting to upload your first conversation."}
      </p>
    </div>
  );
}

function MeetingList({
  meetings,
  totalMeetings,
}: {
  meetings: HomeMeetingListItem[];
  totalMeetings: number;
}) {
  if (meetings.length === 0) {
    return (
      <div className="mt-5 rounded-2xl border border-[#edf0f7] bg-white px-6 py-14 text-center shadow-[0_12px_35px_rgba(17,24,39,0.04)]">
        <h2 className="text-lg font-semibold">No matching meetings</h2>
        <p className="mt-2 text-sm text-[#697391]">
          Adjust your search or status filter to see more meetings.
        </p>
      </div>
    );
  }

  return (
    <div
      className="mt-5 overflow-hidden rounded-2xl border border-[#edf0f7] bg-white shadow-[0_12px_35px_rgba(17,24,39,0.04)]"
      id="meetings-list"
    >
      <div className="hidden md:block">
        <div className="grid grid-cols-[minmax(0,1.45fr)_minmax(120px,0.62fr)_minmax(110px,0.45fr)_minmax(150px,0.55fr)] border-b border-[#edf0f7] px-6 py-4 text-xs font-semibold text-[#66718c] uppercase">
          <div>Meeting</div>
          <div className="flex items-center gap-2">
            Uploaded
            <Icon name="chevron-down" className="size-4" />
          </div>
          <div>Duration</div>
          <div>Status</div>
        </div>
        <ul className="divide-y divide-[#edf0f7]">
          {meetings.map((meeting, index) => (
            <MeetingRow index={index} key={meeting.id} meeting={meeting} />
          ))}
        </ul>
      </div>
      <ul className="divide-y divide-[#edf0f7] md:hidden">
        {meetings.map((meeting, index) => (
          <MeetingCard index={index} key={meeting.id} meeting={meeting} />
        ))}
      </ul>
      <div className="flex flex-col gap-4 border-t border-[#edf0f7] px-5 py-4 text-sm text-[#66718c] sm:flex-row sm:items-center sm:justify-between">
        <p>
          Showing 1-{meetings.length} of {totalMeetings} meetings
        </p>
        <div className="flex items-center gap-2">
          <button
            aria-label="Previous page"
            className="inline-flex size-9 items-center justify-center rounded-lg border border-[#dfe4ef] text-[#66718c] disabled:opacity-40"
            disabled
            type="button"
          >
            <Icon name="chevron-left" className="size-4" />
          </button>
          <span className="inline-flex size-9 items-center justify-center rounded-lg border border-[#5947f5] text-sm font-semibold text-[#5947f5]">
            1
          </span>
          <button
            aria-label="Next page"
            className="inline-flex size-9 items-center justify-center rounded-lg border border-[#dfe4ef] text-[#66718c] disabled:opacity-40"
            disabled
            type="button"
          >
            <Icon name="chevron-right" className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function MeetingRow({
  index,
  meeting,
}: {
  index: number;
  meeting: HomeMeetingListItem;
}) {
  return (
    <li>
      <Link
        className="grid grid-cols-[minmax(0,1.45fr)_minmax(120px,0.62fr)_minmax(110px,0.45fr)_minmax(150px,0.55fr)] items-center gap-4 px-6 py-4 transition hover:bg-[#fafbff]"
        to={`/meetings/${meeting.id}`}
      >
        <div className="flex min-w-0 items-center gap-5">
          <MeetingIcon status={meeting.status} index={index} />
          <h2 className="truncate text-sm font-semibold text-[#151936]">
            {meeting.title}
          </h2>
        </div>
        <p className="text-sm text-[#697391]">
          <RelativeUploadDate createdAt={meeting.createdAt} />
        </p>
        <p className="flex items-center gap-2 text-sm text-[#697391]">
          <Icon name="clock" className="size-4" />
          {meeting.durationSeconds !== null
            ? formatDuration(meeting.durationSeconds)
            : "Pending"}
        </p>
        <StatusBadge
          progress={meeting.transcriptionProgress}
          status={meeting.status}
        />
      </Link>
    </li>
  );
}

function MeetingCard({
  index,
  meeting,
}: {
  index: number;
  meeting: HomeMeetingListItem;
}) {
  return (
    <li>
      <Link
        className="flex flex-col gap-4 px-5 py-5 transition hover:bg-[#fafbff]"
        to={`/meetings/${meeting.id}`}
      >
        <div className="flex items-start gap-4">
          <MeetingIcon status={meeting.status} index={index} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[#151936]">
              {meeting.title}
            </h2>
            <p className="mt-2 text-sm text-[#697391]">
              <RelativeUploadDate createdAt={meeting.createdAt} />
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-[#697391]">
            <Icon name="clock" className="size-4" />
            {meeting.durationSeconds !== null
              ? formatDuration(meeting.durationSeconds)
              : "Pending"}
          </p>
          <StatusBadge
            progress={meeting.transcriptionProgress}
            status={meeting.status}
          />
        </div>
      </Link>
    </li>
  );
}

function MeetingIcon({
  index,
  status,
}: {
  index: number;
  status: MeetingStatus;
}) {
  const palette =
    status === "error"
      ? "from-red-500 to-red-600 text-white"
      : [
          "from-[#e8e4ff] to-[#d8d1ff] text-[#5947f5]",
          "from-[#3575ff] to-[#5947f5] text-white",
          "from-[#ffb11f] to-[#ff8b18] text-white",
          "from-[#e8e4ff] to-[#d8d1ff] text-[#5947f5]",
          "from-[#4fc499] to-[#2cae7f] text-white",
        ][index % 5];
  const icons: IconName[] = ["users", "chart", "megaphone", "file", "users"];

  return (
    <span
      className={`flex size-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${palette}`}
    >
      <Icon
        name={status === "error" ? "alert" : icons[index % icons.length]}
        className="size-5"
      />
    </span>
  );
}

function StatusBadge({
  progress,
  status,
}: {
  progress: number | null;
  status: MeetingStatus;
}) {
  const presentation = getMeetingStatusPresentation({
    status,
    transcriptionProgress: progress,
  });
  const toneStyles: Record<MeetingStatusTone, string> = {
    active: "border-blue-100 bg-blue-50 text-blue-700",
    danger: "border-red-100 bg-red-50 text-red-700",
    queued: "border-violet-100 bg-violet-50 text-violet-700",
    success: "border-emerald-100 bg-emerald-50 text-emerald-700",
  };
  const iconName: Record<MeetingStatusTone, IconName> = {
    active: "refresh",
    danger: "alert",
    queued: "upload",
    success: "check",
  };

  return (
    <span
      className={`inline-flex w-fit items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold ${toneStyles[presentation.tone]}`}
    >
      <Icon name={iconName[presentation.tone]} className="size-4" />
      {presentation.label}
    </span>
  );
}

function RelativeUploadDate({ createdAt }: { createdAt: string }) {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    const updateNow = () => setNowMs(Date.now());

    updateNow();
    const intervalId = window.setInterval(updateNow, 60_000);

    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <time dateTime={createdAt} suppressHydrationWarning>
      {nowMs === null
        ? "Uploaded"
        : formatRelativeTimeFromNow(createdAt, nowMs)}
    </time>
  );
}

function validateRecordingFile(file: File | null | undefined) {
  if (!file) {
    return "Choose one recording file to upload.";
  }

  const lowerName = file.name.toLowerCase();
  const isSupported = acceptedRecordingExtensions.some((extension) =>
    lowerName.endsWith(extension),
  );

  if (!isSupported) {
    return "Unsupported recording type. Upload an .mp3, .m4a, .wav, or .mp4 file.";
  }

  return null;
}

function filterMeetings({
  dateFilter,
  meetings,
  searchTerm,
  statusFilter,
}: {
  dateFilter: DateFilter;
  meetings: HomeMeetingListItem[];
  searchTerm: string;
  statusFilter: MeetingStatusFilter;
}) {
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const nowMs = Date.now();
  const dateThresholdMs =
    dateFilter === "last-7"
      ? nowMs - 7 * 24 * 60 * 60 * 1000
      : dateFilter === "last-30"
        ? nowMs - 30 * 24 * 60 * 60 * 1000
        : null;

  return meetings.filter((meeting) => {
    const matchesSearch =
      normalizedSearchTerm.length === 0 ||
      meeting.title.toLowerCase().includes(normalizedSearchTerm);
    const matchesDate =
      dateThresholdMs === null ||
      new Date(meeting.createdAt).getTime() >= dateThresholdMs;
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active"
        ? meeting.status !== "done" && meeting.status !== "error"
        : meeting.status === statusFilter);

    return matchesSearch && matchesDate && matchesStatus;
  });
}

async function fetchHomeMeetings(): Promise<HomeMeetingsResponse> {
  const response = await fetch("/api/meetings", {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error("Failed to refresh meetings.");
  }

  return (await response.json()) as HomeMeetingsResponse;
}
