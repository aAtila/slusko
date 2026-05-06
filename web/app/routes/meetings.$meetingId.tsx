import { useEffect, useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
  useRevalidator,
} from "react-router";
import type { MeetingStatus } from "~/db/schema";
import type { MeetingDetailActionData as MeetingActionData } from "~/lib/meeting-detail-action.server";
import {
  formatDuration,
  formatTranscriptTimestamp,
  getMeetingStatusPresentation,
  isTerminalMeetingStatus,
  type MeetingDetail,
  type MeetingStatusTone,
  type TranscriptSegment,
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

export async function action({ params, request }: Route.ActionArgs) {
  const { handleMeetingDetailAction } =
    await import("~/lib/meeting-detail-action.server");
  const result = await handleMeetingDetailAction({
    formData: await request.formData(),
    meetingId: params.meetingId,
  });

  if (result.type === "redirect") {
    return redirect(result.to);
  }

  if (result.status) {
    return data(result.data, { status: result.status });
  }

  return result.data;
}

export default function MeetingDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const { meeting, transcriptSegments } = loaderData;
  const actionData = useActionData<MeetingActionData>();
  const navigation = useNavigation();
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(meeting.title);
  const [titleFeedback, setTitleFeedback] = useState<MeetingActionData>();
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

  const submittingIntent = navigation.formData?.get("_intent");
  const isDeleting =
    navigation.state !== "idle" && submittingIntent === "delete-meeting";
  const isUpdatingTitle =
    navigation.state !== "idle" && submittingIntent === "update-title";
  const formattedDuration =
    meeting.durationSeconds === null
      ? "Not available yet"
      : formatDuration(meeting.durationSeconds);
  const titleFeedbackId = "meeting-title-feedback";

  useEffect(() => {
    if (actionData?.intent !== "update-title") {
      return;
    }

    setTitleFeedback(actionData);

    if (actionData.ok) {
      setTitleDraft(actionData.title);
      setIsEditingTitle(false);
      return;
    }

    setIsEditingTitle(true);
  }, [actionData]);

  const beginTitleEdit = () => {
    setTitleDraft(meeting.title);
    setTitleFeedback(undefined);
    setIsEditingTitle(true);
  };

  const cancelTitleEdit = () => {
    setTitleDraft(meeting.title);
    setTitleFeedback(undefined);
    setIsEditingTitle(false);
  };

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
          <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              {isEditingTitle ? (
                <Form className="space-y-3" method="post" preventScrollReset>
                  <input name="_intent" type="hidden" value="update-title" />
                  <label className="sr-only" htmlFor="meeting-title">
                    Meeting title
                  </label>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <input
                      aria-describedby={titleFeedbackId}
                      aria-invalid={
                        titleFeedback?.ok === false && isEditingTitle
                          ? true
                          : undefined
                      }
                      className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-3xl font-semibold tracking-tight text-white transition outline-none placeholder:text-slate-500 focus:border-cyan-200 focus:bg-white/[0.06] sm:text-4xl"
                      disabled={isDeleting || isUpdatingTitle}
                      id="meeting-title"
                      maxLength={200}
                      name="title"
                      onChange={(event) => setTitleDraft(event.target.value)}
                      required
                      value={titleDraft}
                    />
                    <div className="flex gap-2">
                      <button
                        className="inline-flex items-center justify-center rounded-full bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-950/30 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isDeleting || isUpdatingTitle}
                        type="submit"
                      >
                        {isUpdatingTitle ? "Saving…" : "Save"}
                      </button>
                      <button
                        className="inline-flex items-center justify-center rounded-full border border-white/15 px-5 py-3 text-sm font-semibold text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isUpdatingTitle}
                        onClick={cancelTitleEdit}
                        type="button"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                  <TitleFeedback
                    actionData={isEditingTitle ? titleFeedback : undefined}
                    feedbackId={titleFeedbackId}
                  />
                </Form>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                    <h1 className="min-w-0 flex-1 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                      {meeting.title}
                    </h1>
                    <button
                      className="inline-flex w-fit items-center justify-center rounded-full border border-white/15 px-5 py-3 text-sm font-semibold text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isDeleting || isUpdatingTitle}
                      onClick={beginTitleEdit}
                      type="button"
                    >
                      Edit title
                    </button>
                  </div>
                  <TitleFeedback
                    actionData={!isEditingTitle ? titleFeedback : undefined}
                    feedbackId={titleFeedbackId}
                  />
                </div>
              )}
            </div>
            <StatusBadge
              progress={meeting.transcriptionProgress}
              status={meeting.status}
            />
          </div>
          <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
            <DetailField label="Uploaded ISO" value={meeting.createdAt} />
            <DetailField label="Duration" value={formattedDuration} />
            <DetailField label="Status" value={presentation.label} />
          </dl>
          <p className="mt-4 text-sm text-slate-300">
            Current pipeline state: {presentation.label.toLowerCase()}.
          </p>
        </header>

        <section className="mt-8 rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-2xl shadow-black/20">
          <dl className="grid gap-5 sm:grid-cols-2">
            <DetailField label="Status" value={presentation.label} />
            <DetailField label="Duration" value={formattedDuration} />
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

        <section className="mt-8 grid gap-6">
          <PlaceholderPanel
            description="Meeting summaries will appear here after the summarization pipeline is connected."
            title="Summary"
          />
          <TranscriptPanel
            segments={transcriptSegments}
            status={meeting.status}
          />
        </section>

        <section className="mt-8 rounded-3xl border border-orange-300/25 bg-orange-300/10 p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-orange-100">
                Delete meeting
              </h2>
              <p className="mt-2 text-sm text-orange-50/80">
                Removes this meeting record and its stored audio artifacts.
              </p>
              {actionData?.ok === false &&
              actionData.intent === "delete-meeting" ? (
                <p className="mt-3 text-sm font-medium text-orange-100">
                  {actionData.error}
                </p>
              ) : null}
            </div>
            <Form
              method="post"
              onSubmit={(event) => {
                if (
                  !window.confirm(
                    "Delete this meeting and its stored audio artifacts? This cannot be undone.",
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              <input name="_intent" type="hidden" value="delete-meeting" />
              <button
                className="inline-flex items-center justify-center rounded-full border border-orange-200/50 px-5 py-3 text-sm font-semibold text-orange-50 transition hover:bg-orange-200/10 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isDeleting || isUpdatingTitle}
                type="submit"
              >
                {isDeleting ? "Deleting…" : "Delete meeting"}
              </button>
            </Form>
          </div>
        </section>
      </section>
    </main>
  );
}

function TitleFeedback({
  actionData,
  feedbackId,
}: {
  actionData: MeetingActionData | undefined;
  feedbackId: string;
}) {
  if (actionData?.intent !== "update-title") {
    return <p className="sr-only" id={feedbackId} />;
  }

  if (!actionData.ok) {
    return (
      <p className="text-sm font-medium text-orange-100" id={feedbackId}>
        {actionData.error}
      </p>
    );
  }

  return (
    <p className="text-sm font-medium text-emerald-200" id={feedbackId}>
      Title saved as “{actionData.title}”.
    </p>
  );
}

function PlaceholderPanel({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <article className="rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-2xl shadow-black/20">
      <h2 className="text-2xl font-semibold text-white">{title}</h2>
      <p className="mt-3 text-sm leading-6 text-slate-300">{description}</p>
    </article>
  );
}

export function TranscriptPanel({
  segments,
  status,
}: {
  segments: TranscriptSegment[];
  status: MeetingStatus;
}) {
  let emptyMessage = "Transcript will appear here when transcription finishes.";

  if (status === "error") {
    emptyMessage = "No transcript was saved before processing failed.";
  } else if (status === "done") {
    emptyMessage = "Transcript is not available for this meeting.";
  }

  return (
    <article className="rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-2xl shadow-black/20">
      <h2 className="text-2xl font-semibold text-white">Transcript</h2>
      {segments.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-slate-300">{emptyMessage}</p>
      ) : (
        <ol className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1">
          {segments.map((segment) => (
            <li
              className="rounded-2xl border border-white/10 bg-slate-950/60 p-3"
              key={segment.id}
            >
              <p className="text-xs font-semibold tracking-wide text-cyan-200">
                <time>[{formatTranscriptTimestamp(segment.startSeconds)}]</time>{" "}
                {segment.speakerLabel}
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-100">
                {segment.text}
              </p>
            </li>
          ))}
        </ol>
      )}
    </article>
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
