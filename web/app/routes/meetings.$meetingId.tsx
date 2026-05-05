import { useEffect } from "react";
import { Link, useRevalidator } from "react-router";
import type { MeetingStatus } from "~/db/schema";
import {
  formatDuration,
  getMeetingStatusPresentation,
  isTerminalMeetingStatus,
  type MeetingDetail,
  type MeetingStatusTone,
} from "~/lib/meetings-list";
import type { Route } from "./+types/meetings.$meetingId";

export function meta({ data }: Route.MetaArgs) {
  const title = data?.meeting.title ?? "Meeting";

  return [
    { title: `${title} — Slusko` },
    {
      name: "description",
      content: "Meeting pipeline status and processing details.",
    },
  ];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { loadMeetingDetailRouteData } =
    await import("~/lib/meetings-list.server");

  return loadMeetingDetailRouteData(params.meetingId);
}

export default function MeetingDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const { meeting } = loaderData;
  const { revalidate } = useRevalidator();
  const presentation = getMeetingStatusPresentation({
    status: meeting.status,
    transcriptionProgress: meeting.transcriptionProgress,
  });

  useEffect(() => {
    if (isTerminalMeetingStatus(meeting.status)) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void revalidate();
    }, 5_000);

    return () => window.clearInterval(intervalId);
  }, [meeting.status, revalidate]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50">
      <section className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-6 py-10 sm:px-8 lg:px-10">
        <Link
          className="text-sm font-medium text-cyan-200 transition hover:text-cyan-100"
          to="/"
        >
          ← Back to meetings
        </Link>

        <header className="mt-8 border-b border-white/10 pb-8">
          <p className="text-sm font-medium tracking-[0.3em] text-cyan-300 uppercase">
            Meeting detail
          </p>
          <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <h1 className="text-4xl font-semibold tracking-tight">
              {meeting.title}
            </h1>
            <StatusBadge
              progress={meeting.transcriptionProgress}
              status={meeting.status}
            />
          </div>
          <p className="mt-4 text-sm text-slate-300">
            Current pipeline state: {presentation.label.toLowerCase()}.
          </p>
        </header>

        <section className="mt-8 rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-2xl shadow-black/20">
          <dl className="grid gap-5 sm:grid-cols-2">
            <DetailField label="Status" value={presentation.label} />
            <DetailField
              label="Duration"
              value={
                meeting.durationSeconds === null
                  ? "Not available yet"
                  : formatDuration(meeting.durationSeconds)
              }
            />
            <DetailField
              label="Uploaded"
              value={formatUploadedAt(meeting.createdAt)}
            />
            {meeting.status === "transcribing" ? (
              <DetailField
                label="Transcription progress"
                value={
                  meeting.transcriptionProgress === null
                    ? "In progress"
                    : `${meeting.transcriptionProgress}%`
                }
              />
            ) : null}
          </dl>

          {meeting.status === "error" ? <ErrorBlock meeting={meeting} /> : null}
        </section>
      </section>
    </main>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase">
        {label}
      </dt>
      <dd className="mt-2 text-base text-slate-100">{value}</dd>
    </div>
  );
}

function ErrorBlock({ meeting }: { meeting: MeetingDetail }) {
  return (
    <div className="mt-8 rounded-2xl border border-orange-300/25 bg-orange-300/10 p-5">
      <h2 className="text-lg font-semibold text-orange-100">
        Processing failed
      </h2>
      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
        <DetailField
          label="Error kind"
          value={meeting.errorKind ?? "Unknown"}
        />
        <DetailField
          label="Failed at stage"
          value={meeting.failedAtStage ?? "Unknown"}
        />
        <div className="sm:col-span-2">
          <dt className="text-xs font-semibold tracking-[0.2em] text-orange-200/70 uppercase">
            Error message
          </dt>
          <dd className="mt-2 text-orange-50">
            {meeting.errorMessage ?? "No error message was recorded."}
          </dd>
        </div>
      </dl>
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
  const presentation = getMeetingStatusPresentation({
    status,
    transcriptionProgress: progress,
  });
  const toneStyles: Record<MeetingStatusTone, string> = {
    active: "border-cyan-300/30 bg-cyan-300/10 text-cyan-100",
    danger: "border-orange-300/40 bg-orange-300/15 text-orange-100",
    queued: "border-slate-300/25 bg-slate-300/10 text-slate-200",
    success: "border-emerald-300/30 bg-emerald-300/10 text-emerald-200",
  };

  return (
    <span
      className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-semibold ${toneStyles[presentation.tone]}`}
    >
      {presentation.label}
    </span>
  );
}

function formatUploadedAt(createdAt: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "UTC",
    timeZoneName: "short",
    year: "numeric",
  }).format(new Date(createdAt));
}
