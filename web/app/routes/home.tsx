import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ElementType,
  type FormEvent,
} from "react";
import { data, Link, useFetcher } from "react-router";
import { Icon } from "~/components/app-icons";
import { useAppShellChrome, type AppShellChrome } from "~/components/app-shell";
import {
  getMeetingListItemPresentation,
  type MeetingListItemIconPresentation,
} from "~/lib/meeting-list-presentation";
import {
  shouldPollMeetings,
  type HomeMeetingListItem,
  type MeetingStatusPresentation,
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
  const [clientError, setClientError] = useState<string | null>(null);
  const [isDraggingRecording, setIsDraggingRecording] = useState(false);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [selectedUploadFileName, setSelectedUploadFileName] = useState<
    string | null
  >(null);
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
  const openUploadDialog = useCallback(() => {
    if (isUploading) {
      return;
    }

    setClientError(null);
    setIsUploadDialogOpen(true);
  }, [isUploading]);

  useEffect(() => {
    queryClient.setQueryData<HomeMeetingsResponse>(homeMeetingsQueryKey, {
      meetings: loaderData.meetings,
    });
  }, [loaderData.meetings, queryClient]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok === true) {
      setIsUploadDialogOpen(false);
      setSelectedUploadFileName(null);
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
  const handleUploadFormFileChange = useCallback(
    (file: File | null | undefined) => {
      setSelectedUploadFileName(file?.name ?? null);

      const validationError = file ? validateRecordingFile(file) : null;
      setClientError(validationError);
    },
    [],
  );

  const handleUploadFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (isUploading) {
        event.preventDefault();
        setClientError("Wait for the current upload to finish.");
        return;
      }

      const formData = new FormData(event.currentTarget);
      const recording = formData.get("recording");
      const validationError =
        recording instanceof File
          ? validateRecordingFile(recording)
          : "Choose one recording file to upload.";

      if (validationError !== null) {
        event.preventDefault();
        setClientError(validationError);
        return;
      }

      setClientError(null);
    },
    [isUploading],
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
        onClick: openUploadDialog,
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
      openUploadDialog,
      submitRecording,
    ],
  );

  useAppShellChrome(shellChrome);

  return (
    <section className="flex min-w-0 flex-1 flex-col px-4 py-5 sm:px-6 md:px-8 lg:px-10 lg:py-11">
      {isUploadDialogOpen ? (
        <UploadDialog
          FormComponent={fetcher.Form}
          isUploading={isUploading}
          selectedFileName={selectedUploadFileName}
          onCancel={() => setIsUploadDialogOpen(false)}
          onFileChange={handleUploadFormFileChange}
          onSubmit={handleUploadFormSubmit}
        />
      ) : null}
      <header className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="font-display text-ink text-[2.5rem] leading-[1.04] font-medium tracking-[-0.015em] sm:text-[3rem]">
            Meetings
          </h1>
          <p className="text-ink-muted mt-3 text-sm leading-6 sm:text-base">
            Upload, review, and manage meeting transcripts
          </p>
        </div>
        <button
          className="bg-brand text-canvas hover:bg-brand-deep hidden h-12 items-center justify-center gap-2 rounded-lg px-6 text-sm font-medium shadow-[0_10px_24px_-8px_rgba(63,90,48,0.45)] transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 md:inline-flex"
          disabled={isUploading}
          onClick={openUploadDialog}
          type="button"
        >
          <Icon name="plus" className="size-5" />
          {isUploading ? "Uploading..." : "New Meeting"}
        </button>
      </header>

      {uploadError ? (
        <p className="border-danger-soft bg-danger-soft/60 text-danger mt-5 rounded-xl border px-4 py-3 text-sm">
          {uploadError}
        </p>
      ) : null}

      <UploadPanel
        isDraggingRecording={isDraggingRecording}
        isUploading={isUploading}
        onBrowseFiles={openUploadDialog}
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

export function UploadDialog({
  FormComponent = "form",
  isUploading,
  selectedFileName,
  onCancel,
  onFileChange,
  onSubmit,
}: {
  FormComponent?: ElementType;
  isUploading: boolean;
  selectedFileName: string | null;
  onCancel: () => void;
  onFileChange: (file: File | null | undefined) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div
      aria-labelledby="upload-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6"
      role="dialog"
    >
      <div className="bg-surface border-hairline w-full max-w-lg rounded-2xl border p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              className="font-display text-ink text-2xl font-medium tracking-tight"
              id="upload-dialog-title"
            >
              New Meeting
            </h2>
            <p className="text-ink-muted mt-2 text-sm leading-6">
              Choose a recording and transcription language before queueing it.
            </p>
          </div>
          <button
            aria-label="Close upload dialog"
            className="text-ink-muted hover:text-ink rounded-lg p-2 transition disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isUploading}
            onClick={onCancel}
            type="button"
          >
            <Icon name="plus" className="size-5 rotate-45" />
          </button>
        </div>

        <FormComponent
          className="mt-6 flex flex-col gap-5"
          encType="multipart/form-data"
          method="post"
          onSubmit={onSubmit}
        >
          <label className="flex flex-col gap-2" htmlFor="recording-upload">
            <span className="text-ink text-sm font-medium">Recording</span>
            <input
              accept={acceptedRecordingTypes}
              className="border-hairline bg-surface-elevated text-ink file:bg-brand file:text-canvas focus:border-brand rounded-lg border px-3 py-2 text-sm transition outline-none file:border-0 file:px-4 file:py-2 file:text-sm file:font-medium"
              disabled={isUploading}
              id="recording-upload"
              name="recording"
              onChange={(event) =>
                onFileChange(event.currentTarget.files?.item(0))
              }
              required
              type="file"
            />
          </label>

          {selectedFileName ? (
            <p className="text-ink-muted text-sm">
              Selected: {selectedFileName}
            </p>
          ) : null}

          <label className="flex flex-col gap-2" htmlFor="meeting-language">
            <span className="text-ink text-sm font-medium">
              Transcription language
            </span>
            <select
              className="border-hairline bg-surface-elevated text-ink focus:border-brand h-11 rounded-lg border px-3 text-sm outline-none"
              defaultValue="sr"
              disabled={isUploading}
              id="meeting-language"
              name="language"
            >
              <option value="sr">Serbian</option>
              <option value="en">English</option>
              <option value="auto">Auto-detect</option>
            </select>
          </label>

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              className="border-hairline bg-surface-elevated text-ink hover:border-brand/40 inline-flex h-11 items-center justify-center rounded-lg border px-5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isUploading}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="bg-brand text-canvas hover:bg-brand-deep inline-flex h-11 items-center justify-center rounded-lg px-5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isUploading}
              type="submit"
            >
              {isUploading ? "Uploading..." : "Upload meeting"}
            </button>
          </div>
        </FormComponent>
      </div>
    </div>
  );
}

export function UploadPanel({
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
          ? "border-brand bg-brand-soft"
          : "border-hairline-strong bg-surface"
      }`}
    >
      <div className="bg-brand-soft text-brand mx-auto flex size-14 items-center justify-center rounded-2xl">
        <Icon name="upload-cloud" className="size-7" />
      </div>
      <h2 className="text-ink mt-5 text-lg font-medium">
        Drop audio or video files here
      </h2>
      <p className="text-ink-muted mt-2 text-sm leading-6">
        Supports MP3, WAV, M4A, MP4 and more. Dropped files use Serbian by
        default; browse to choose English or Auto-detect.
      </p>
      <button
        className="border-hairline bg-surface-elevated text-ink hover:border-brand/40 mt-4 inline-flex h-12 items-center justify-center gap-2 rounded-lg border px-6 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isUploading}
        onClick={onBrowseFiles}
        type="button"
      >
        <Icon name="folder" className="text-ink-muted size-5" />
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
            className="border-hairline bg-surface-elevated text-ink focus:border-brand h-11 w-full appearance-none rounded-lg border px-4 pr-10 text-sm font-medium transition outline-none sm:w-40"
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
            className="text-ink-muted pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2"
          />
        </div>
        <label className="sr-only" htmlFor="date-filter">
          Filter by upload date
        </label>
        <div className="relative">
          <Icon
            name="calendar"
            className="text-ink-muted pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2"
          />
          <select
            className="border-hairline bg-surface-elevated text-ink focus:border-brand h-11 w-full appearance-none rounded-lg border pr-10 pl-10 text-sm font-medium transition outline-none sm:w-44"
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
            className="text-ink-muted pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2"
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
            className="text-ink-muted pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2"
          />
          <input
            className="border-hairline bg-surface-elevated text-ink placeholder:text-ink-subtle focus:border-brand h-11 w-full rounded-lg border pr-4 pl-12 text-sm transition outline-none"
            id="meeting-search"
            onChange={(event) => onSearchTermChange(event.currentTarget.value)}
            placeholder="Search meetings..."
            type="search"
            value={searchTerm}
          />
        </label>
        <button
          aria-label="Reset filters"
          className="border-hairline bg-surface-elevated text-ink-muted hover:text-ink inline-flex size-11 shrink-0 items-center justify-center rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-45"
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
    <div className="border-hairline bg-surface mt-5 flex min-h-80 w-full flex-col items-center justify-center rounded-2xl border px-6 py-16 text-center shadow-[0_1px_0_rgba(28,27,24,0.04),0_18px_40px_-24px_rgba(28,27,24,0.12)]">
      <div className="bg-brand-soft text-brand flex size-14 items-center justify-center rounded-2xl">
        <Icon name="upload-cloud" className="size-7" />
      </div>
      <h2 className="font-display mt-6 text-2xl font-medium tracking-tight">
        No meetings yet
      </h2>
      <p className="text-ink-muted mt-3 max-w-md text-sm leading-6">
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
      <div className="border-hairline bg-surface mt-5 rounded-2xl border px-6 py-14 text-center shadow-[0_1px_0_rgba(28,27,24,0.04),0_18px_40px_-24px_rgba(28,27,24,0.12)]">
        <h2 className="text-ink text-lg font-medium">No matching meetings</h2>
        <p className="text-ink-muted mt-2 text-sm">
          Adjust your search or status filter to see more meetings.
        </p>
      </div>
    );
  }

  return (
    <div
      className="border-hairline bg-surface mt-5 overflow-hidden rounded-2xl border shadow-[0_1px_0_rgba(28,27,24,0.04),0_18px_40px_-24px_rgba(28,27,24,0.12)]"
      id="meetings-list"
    >
      <div className="hidden md:block">
        <div className="border-hairline text-ink-muted grid grid-cols-[minmax(0,1.45fr)_minmax(120px,0.62fr)_minmax(90px,0.38fr)_minmax(130px,0.5fr)_minmax(150px,0.55fr)] border-b px-6 py-4 text-xs font-medium tracking-[0.08em] uppercase">
          <div>Meeting</div>
          <div className="flex items-center gap-2">
            Uploaded
            <Icon name="chevron-down" className="size-4" />
          </div>
          <div>Duration</div>
          <div>Language</div>
          <div>Status</div>
        </div>
        <ul className="divide-hairline divide-y">
          {meetings.map((meeting, index) => (
            <MeetingRow index={index} key={meeting.id} meeting={meeting} />
          ))}
        </ul>
      </div>
      <ul className="divide-hairline divide-y md:hidden">
        {meetings.map((meeting, index) => (
          <MeetingCard index={index} key={meeting.id} meeting={meeting} />
        ))}
      </ul>
      <div className="border-hairline text-ink-muted flex flex-col gap-4 border-t px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p>
          Showing 1-{meetings.length} of {totalMeetings} meetings
        </p>
        <div className="flex items-center gap-2">
          <button
            aria-label="Previous page"
            className="border-hairline text-ink-muted inline-flex size-9 items-center justify-center rounded-lg border disabled:opacity-40"
            disabled
            type="button"
          >
            <Icon name="chevron-left" className="size-4" />
          </button>
          <span className="border-brand bg-brand-soft text-brand inline-flex size-9 items-center justify-center rounded-lg border text-sm font-medium">
            1
          </span>
          <button
            aria-label="Next page"
            className="border-hairline text-ink-muted inline-flex size-9 items-center justify-center rounded-lg border disabled:opacity-40"
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

export function MeetingRow({
  index,
  meeting,
}: {
  index: number;
  meeting: HomeMeetingListItem;
}) {
  const presentation = getMeetingListItemPresentation(meeting, index);

  return (
    <li>
      <Link
        className="hover:bg-canvas grid grid-cols-[minmax(0,1.45fr)_minmax(120px,0.62fr)_minmax(90px,0.38fr)_minmax(130px,0.5fr)_minmax(150px,0.55fr)] items-center gap-4 px-6 py-4 transition"
        to={`/meetings/${meeting.id}`}
      >
        <div className="flex min-w-0 items-center gap-5">
          <MeetingIcon presentation={presentation.icon} />
          <div className="min-w-0">
            <h2 className="text-ink truncate text-sm font-medium">
              {meeting.title}
            </h2>
            {presentation.failure ? (
              <p className="text-danger mt-1 line-clamp-2 text-xs leading-5">
                {presentation.failure.message}
              </p>
            ) : null}
          </div>
        </div>
        <p className="text-ink-muted text-sm">
          <RelativeUploadDate createdAt={meeting.createdAt} />
        </p>
        <p className="text-ink-muted flex items-center gap-2 font-mono text-sm tabular-nums">
          <Icon name="clock" className="size-4" />
          <span>{presentation.durationLabel}</span>
        </p>
        <p className="text-ink-muted text-sm">{presentation.languageLabel}</p>
        <StatusBadge presentation={presentation.statusBadge} />
      </Link>
    </li>
  );
}

export function MeetingCard({
  index,
  meeting,
}: {
  index: number;
  meeting: HomeMeetingListItem;
}) {
  const presentation = getMeetingListItemPresentation(meeting, index);

  return (
    <li>
      <Link
        className="hover:bg-canvas flex flex-col gap-4 px-5 py-5 transition"
        to={`/meetings/${meeting.id}`}
      >
        <div className="flex items-start gap-4">
          <MeetingIcon presentation={presentation.icon} />
          <div className="min-w-0 flex-1">
            <h2 className="text-ink text-sm font-medium">{meeting.title}</h2>
            {presentation.failure ? (
              <p className="text-danger mt-1 text-xs leading-5">
                {presentation.failure.message}
              </p>
            ) : null}
            <p className="text-ink-muted mt-2 text-sm">
              <RelativeUploadDate createdAt={meeting.createdAt} />
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <p className="text-ink-muted flex items-center gap-2 font-mono text-sm tabular-nums">
              <Icon name="clock" className="size-4" />
              <span>{presentation.durationLabel}</span>
            </p>
            <p className="text-ink-muted text-sm">
              {presentation.languageLabel}
            </p>
          </div>
          <StatusBadge presentation={presentation.statusBadge} />
        </div>
      </Link>
    </li>
  );
}

function MeetingIcon({
  presentation,
}: {
  presentation: MeetingListItemIconPresentation;
}) {
  return (
    <span
      className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${presentation.palette}`}
    >
      <Icon name={presentation.name} className="size-5" />
    </span>
  );
}

function StatusBadge({
  presentation,
}: {
  presentation: MeetingStatusPresentation;
}) {
  const toneStyles: Record<MeetingStatusPresentation["tone"], string> = {
    active: "border-brand/20 bg-brand-soft text-brand",
    danger: "border-danger/20 bg-danger-soft text-danger",
    queued: "border-hairline bg-surface-sunken text-ink-soft",
    success: "border-success/20 bg-success-soft text-success",
  };

  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-[0.04em] uppercase ${toneStyles[presentation.tone]}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${
          presentation.tone === "active"
            ? "bg-brand animate-pulse"
            : "bg-current"
        }`}
      />
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
