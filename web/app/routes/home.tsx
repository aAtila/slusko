import { useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import type { MeetingStatus } from "~/db/schema";
import type { Route } from "./+types/home";

const acceptedRecordingExtensions = [".mp3", ".m4a", ".wav", ".mp4"] as const;
const acceptedRecordingTypes = acceptedRecordingExtensions.join(",");

type MeetingListItem = {
  id: string;
  title: string;
  status: MeetingStatus;
  transcriptionProgress: number | null;
  durationSeconds: number | null;
  createdAt: string;
};

type UploadActionData =
  | { ok: true; meetingId: string }
  | { ok: false; error: string };

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Meetings — Slusko" },
    {
      name: "description",
      content: "Upload, transcribe, and summarize internal meetings.",
    },
  ];
}

export async function loader() {
  const [{ desc }, { db }, { meetings }] = await Promise.all([
    import("drizzle-orm"),
    import("~/db/client.server"),
    import("~/db/schema"),
  ]);

  const rows = await db
    .select({
      id: meetings.id,
      title: meetings.title,
      status: meetings.status,
      transcriptionProgress: meetings.transcriptionProgress,
      durationSeconds: meetings.durationSeconds,
      createdAt: meetings.createdAt,
    })
    .from(meetings)
    .orderBy(desc(meetings.createdAt));

  return {
    meetings: rows.map((meeting) => ({
      ...meeting,
      createdAt: meeting.createdAt.toISOString(),
    })) satisfies MeetingListItem[],
  };
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
  const { meetings } = loaderData;
  const fetcher = useFetcher<UploadActionData>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [isDraggingRecording, setIsDraggingRecording] = useState(false);
  const isUploading = fetcher.state !== "idle";
  const actionError = fetcher.data?.ok === false ? fetcher.data.error : null;
  const uploadError = clientError ?? actionError;

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
    <main className="min-h-screen bg-slate-950 text-slate-50">
      <section
        className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-10 sm:px-8 lg:px-10"
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDraggingRecording(true);
        }}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
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
        <header className="flex flex-col gap-6 border-b border-white/10 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium tracking-[0.3em] text-cyan-300 uppercase">
              Slusko
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
              Meetings
            </h1>
            <p className="mt-4 max-w-2xl text-base text-slate-300">
              Drop in a recording, then follow transcription, diarization, and
              summary progress from one list.
            </p>
          </div>
          <div className="flex flex-col items-start gap-3 sm:items-end">
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
            <button
              className="inline-flex items-center justify-center rounded-full bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-950/30 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isUploading}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              {isUploading ? "Uploading…" : "+ New Meeting"}
            </button>
            <p className="text-xs text-slate-400">
              MP3, M4A, WAV, or MP4 · up to the configured upload limit
            </p>
          </div>
        </header>

        {uploadError ? (
          <p className="mt-5 rounded-2xl border border-orange-300/25 bg-orange-300/10 px-4 py-3 text-sm text-orange-100">
            {uploadError}
          </p>
        ) : null}

        <div
          className={`mt-8 flex flex-1 rounded-3xl border border-dashed p-4 shadow-2xl shadow-black/20 transition sm:p-6 ${
            isDraggingRecording
              ? "border-cyan-200 bg-cyan-300/10"
              : "border-white/15 bg-white/[0.03]"
          }`}
        >
          {meetings.length === 0 ? (
            <EmptyMeetings isUploading={isUploading} />
          ) : (
            <MeetingList meetings={meetings} />
          )}
        </div>
      </section>
    </main>
  );
}

function EmptyMeetings({ isUploading }: { isUploading: boolean }) {
  return (
    <div className="flex w-full flex-col items-center justify-center rounded-2xl border border-white/10 bg-slate-900/70 px-6 py-20 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-cyan-300/15 text-2xl">
        🎙️
      </div>
      <h2 className="mt-6 text-2xl font-semibold">No meetings yet</h2>
      <p className="mt-3 max-w-md text-sm leading-6 text-slate-300">
        {isUploading
          ? "Uploading your recording and queueing the meeting…"
          : "Drag and drop an audio or video recording here, or use New Meeting to upload your first conversation."}
      </p>
    </div>
  );
}

function MeetingList({ meetings }: { meetings: MeetingListItem[] }) {
  return (
    <div className="w-full overflow-hidden rounded-2xl border border-white/10 bg-slate-900/70">
      <ul className="divide-y divide-white/10">
        {meetings.map((meeting) => (
          <li
            className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
            key={meeting.id}
          >
            <div>
              <h2 className="text-lg font-medium text-white">
                {meeting.title}
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                {formatAbsoluteDate(meeting.createdAt)}
                {meeting.durationSeconds !== null
                  ? ` · ${formatDuration(meeting.durationSeconds)}`
                  : ""}
              </p>
            </div>
            <StatusBadge
              progress={meeting.transcriptionProgress}
              status={meeting.status}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({
  progress,
  status,
}: {
  progress: number | null;
  status: MeetingStatus;
}) {
  const terminalStyles = {
    done: "border-emerald-300/30 bg-emerald-300/10 text-emerald-200",
    error: "border-orange-300/30 bg-orange-300/10 text-orange-200",
  } as const;

  const className =
    status === "done" || status === "error"
      ? terminalStyles[status]
      : "border-cyan-300/30 bg-cyan-300/10 text-cyan-100";

  const label =
    status === "transcribing" && progress !== null
      ? `Transcribing ${progress}%`
      : status.replaceAll("_", " ");

  return (
    <span
      className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-semibold capitalize ${className}`}
    >
      {label}
    </span>
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

function formatAbsoluteDate(value: string) {
  const createdAt = new Date(value);

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(createdAt);
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }

  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}
