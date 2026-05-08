import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { data, Link, useFetcher } from "react-router";
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

  const submitRecording = (file: File | null | undefined) => {
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
  };

  return (
    <main
      className="min-h-screen bg-white text-[#151936]"
      onDragEnter={(event) => {
        event.preventDefault();
        setIsDraggingRecording(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDraggingRecording(false);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDraggingRecording(false);

        if (event.dataTransfer.files.length !== 1) {
          setClientError("Upload one recording file at a time.");
          return;
        }

        submitRecording(event.dataTransfer.files.item(0));
      }}
    >
      <div className="flex min-h-screen">
        <Sidebar
          completedMeetingsCount={completedMeetingsCount}
          isUploading={isUploading}
          meetingsCount={meetings.length}
          onNewMeeting={() => fileInputRef.current?.click()}
        />
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
          <MobileHeader
            isUploading={isUploading}
            onNewMeeting={() => fileInputRef.current?.click()}
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
              onClick={() => fileInputRef.current?.click()}
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
            onBrowseFiles={() => fileInputRef.current?.click()}
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
      </div>
    </main>
  );
}

function Sidebar({
  completedMeetingsCount,
  isUploading,
  meetingsCount,
  onNewMeeting,
}: {
  completedMeetingsCount: number;
  isUploading: boolean;
  meetingsCount: number;
  onNewMeeting: () => void;
}) {
  return (
    <aside className="hidden w-[258px] shrink-0 border-r border-[#edf0f7] bg-white px-6 py-8 lg:flex lg:flex-col">
      <Link className="flex items-center gap-3 text-lg font-semibold" to="/">
        <LogoMark />
        <span>MeetNotes</span>
      </Link>
      <button
        className="mt-10 inline-flex h-12 items-center justify-center gap-3 rounded-lg bg-[#5947f5] text-sm font-semibold text-white shadow-[0_14px_30px_rgba(89,71,245,0.22)] transition hover:bg-[#4938dc] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isUploading}
        onClick={onNewMeeting}
        type="button"
      >
        <Icon name="plus" className="size-5" />
        {isUploading ? "Uploading..." : "New Meeting"}
      </button>
      <nav className="mt-9 space-y-2 text-sm font-medium text-[#151936]">
        <Link
          className="flex items-center gap-3 rounded-lg bg-[#f2f0ff] px-3 py-3 text-[#5947f5]"
          to="/"
        >
          <Icon name="home" className="size-5" />
          Home
        </Link>
        <a
          className="flex items-center gap-3 rounded-lg px-3 py-3"
          href="#meetings-list"
        >
          <Icon name="calendar" className="size-5 text-[#66718c]" />
          Meetings
        </a>
        <a
          className="flex items-center gap-3 rounded-lg px-3 py-3"
          href="#meetings-search"
        >
          <Icon name="search" className="size-5 text-[#66718c]" />
          Search
        </a>
        <div className="flex items-center gap-3 rounded-lg px-3 py-3 text-[#66718c]">
          <Icon name="users" className="size-5" />
          Speakers
        </div>
        <div className="flex items-center gap-3 rounded-lg px-3 py-3 text-[#66718c]">
          <Icon name="file" className="size-5" />
          Templates
        </div>
        <div className="flex items-center gap-3 rounded-lg px-3 py-3 text-[#66718c]">
          <Icon name="settings" className="size-5" />
          Settings
        </div>
      </nav>
      <div className="mt-auto">
        <div className="rounded-lg border border-[#edf0f7] p-4 shadow-[0_10px_25px_rgba(17,24,39,0.03)]">
          <div className="flex items-center justify-between text-sm font-medium">
            <span>Storage</span>
            <span className="text-xs text-[#697391]">28%</span>
          </div>
          <p className="mt-2 text-xs text-[#697391]">
            {completedMeetingsCount} processed / {meetingsCount} meetings
          </p>
          <div className="mt-4 h-1.5 rounded-full bg-[#edf0f7]">
            <div className="h-full w-[28%] rounded-full bg-[#5947f5]" />
          </div>
        </div>
        <div className="mt-7 border-t border-[#edf0f7] pt-6">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-full bg-[#edf0f7] text-sm font-semibold text-[#151936]">
              AA
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Atila</p>
              <p className="text-xs text-[#697391]">Admin</p>
            </div>
            <Icon
              name="chevron-down"
              className="ml-auto size-4 text-[#66718c]"
            />
          </div>
        </div>
      </div>
    </aside>
  );
}

function MobileHeader({
  isUploading,
  onNewMeeting,
}: {
  isUploading: boolean;
  onNewMeeting: () => void;
}) {
  return (
    <div className="mb-7 flex items-center justify-between gap-3 lg:hidden">
      <Link className="flex min-w-0 items-center gap-3 font-semibold" to="/">
        <LogoMark />
        <span className="truncate">MeetNotes</span>
      </Link>
      <button
        aria-label={isUploading ? "Uploading meeting" : "New Meeting"}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-[#5947f5] text-white shadow-[0_12px_24px_rgba(89,71,245,0.2)] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isUploading}
        onClick={onNewMeeting}
        type="button"
      >
        <Icon name="plus" className="size-5" />
      </button>
    </div>
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

function LogoMark() {
  return (
    <span className="flex size-8 items-center justify-center text-[#5947f5]">
      <svg aria-hidden="true" fill="none" viewBox="0 0 32 32">
        <path
          d="M7 13v6M12 8v16M17 5v22M22 10v12M27 14v4"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="3.5"
        />
      </svg>
    </span>
  );
}

type IconName =
  | "alert"
  | "calendar"
  | "chart"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "clock"
  | "file"
  | "folder"
  | "home"
  | "megaphone"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "sliders"
  | "upload"
  | "upload-cloud"
  | "users";

function Icon({ className, name }: { className?: string; name: IconName }) {
  const common = {
    className,
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 2,
    viewBox: "0 0 24 24",
    "aria-hidden": true,
  };

  switch (name) {
    case "alert":
      return (
        <svg {...common}>
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <path d="M8 2v4" />
          <path d="M16 2v4" />
          <rect height="18" rx="2" width="18" x="3" y="4" />
          <path d="M3 10h18" />
        </svg>
      );
    case "chart":
      return (
        <svg {...common}>
          <path d="M5 20V10" />
          <path d="M12 20V4" />
          <path d="M19 20v-7" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="m5 12 4 4L19 6" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...common}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    case "chevron-left":
      return (
        <svg {...common}>
          <path d="m15 18-6-6 6-6" />
        </svg>
      );
    case "chevron-right":
      return (
        <svg {...common}>
          <path d="m9 18 6-6-6-6" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "file":
      return (
        <svg {...common}>
          <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v5h5" />
          <path d="M9 13h6" />
          <path d="M9 17h4" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
      );
    case "home":
      return (
        <svg {...common}>
          <path d="m3 11 9-8 9 8" />
          <path d="M5 10v10h14V10" />
          <path d="M9 20v-6h6v6" />
        </svg>
      );
    case "megaphone":
      return (
        <svg {...common}>
          <path d="m3 11 14-6v14L3 13Z" />
          <path d="M7 14v5a2 2 0 0 0 2 2h1" />
          <path d="M21 9v6" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...common}>
          <path d="M21 12a9 9 0 0 1-9 9 8.7 8.7 0 0 1-6.3-2.7" />
          <path d="M3 12a9 9 0 0 1 15.3-6.3" />
          <path d="M3 18v-6h6" />
          <path d="M21 6v6h-6" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V22a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 18l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.3 8A2 2 0 1 1 7.1 5.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
        </svg>
      );
    case "sliders":
      return (
        <svg {...common}>
          <path d="M4 6h10" />
          <path d="M18 6h2" />
          <path d="M4 12h3" />
          <path d="M11 12h9" />
          <path d="M4 18h10" />
          <path d="M18 18h2" />
          <circle cx="16" cy="6" r="2" />
          <circle cx="9" cy="12" r="2" />
          <circle cx="16" cy="18" r="2" />
        </svg>
      );
    case "upload":
      return (
        <svg {...common}>
          <path d="M12 3v12" />
          <path d="m7 8 5-5 5 5" />
          <path d="M5 21h14" />
        </svg>
      );
    case "upload-cloud":
      return (
        <svg {...common}>
          <path d="M16 16l-4-4-4 4" />
          <path d="M12 12v9" />
          <path d="M20.4 18.5A5 5 0 0 0 18 9h-1.3A8 8 0 1 0 4 16.3" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-8 0v2" />
          <circle cx="12" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
          <path d="M16 3.1a4 4 0 0 1 0 7.8" />
        </svg>
      );
    default: {
      const exhaustiveName: never = name;
      return exhaustiveName;
    }
  }
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
