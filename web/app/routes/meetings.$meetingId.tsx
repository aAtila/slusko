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
import type { MeetingStatus, SummaryActionItemOwner } from "~/db/schema";
import type { MeetingDetailActionData as MeetingActionData } from "~/lib/meeting-detail-action.server";
import {
  formatDuration,
  formatTranscriptTimestamp,
  getMeetingStatusPresentation,
  isTerminalMeetingStatus,
  type MeetingDetail,
  type MeetingStatusTone,
  type MeetingSummary,
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
  const { meeting, summary, transcriptSegments } = loaderData;
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
  const uploadedLabel = formatMeetingDate(meeting.createdAt);
  const speakerStats = getSpeakerStats(transcriptSegments);
  const keyTopics = getKeyTopics(summary, transcriptSegments);

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
    <section className="min-w-0 flex-1 text-slate-950">
      <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
        <header className="border-b border-slate-200 pb-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <Link
                className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 transition hover:text-indigo-600"
                to="/"
              >
                <span aria-hidden="true">‹</span>
                Back to Meetings
              </Link>

              <div className="mt-6 min-w-0">
                {isEditingTitle ? (
                  <Form className="space-y-3" method="post" preventScrollReset>
                    <input name="_intent" type="hidden" value="update-title" />
                    <label className="sr-only" htmlFor="meeting-title">
                      Meeting title
                    </label>
                    <div className="flex flex-col gap-3 md:flex-row">
                      <input
                        aria-describedby={titleFeedbackId}
                        aria-invalid={
                          titleFeedback?.ok === false && isEditingTitle
                            ? true
                            : undefined
                        }
                        className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-4 py-3 text-2xl font-semibold tracking-tight text-slate-950 transition outline-none placeholder:text-slate-400 focus:border-indigo-500 sm:text-3xl"
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
                          className="inline-flex h-11 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={isDeleting || isUpdatingTitle}
                          type="submit"
                        >
                          {isUpdatingTitle ? "Saving…" : "Save"}
                        </button>
                        <button
                          className="inline-flex h-11 items-center justify-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
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
                    <div className="flex min-w-0 items-start gap-3">
                      <h1 className="min-w-0 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                        {meeting.title}
                      </h1>
                      <button
                        aria-label="Edit meeting title"
                        className="mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-transparent text-slate-500 transition hover:border-slate-200 hover:bg-slate-50 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isDeleting || isUpdatingTitle}
                        onClick={beginTitleEdit}
                        type="button"
                      >
                        ✎
                      </button>
                    </div>
                    <TitleFeedback
                      actionData={!isEditingTitle ? titleFeedback : undefined}
                      feedbackId={titleFeedbackId}
                    />
                  </div>
                )}
              </div>

              <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
                <InlineMeta label="Uploaded" value={uploadedLabel} />
                <InlineMeta label="Duration" value={formattedDuration} />
                <InlineMeta
                  label="Speakers"
                  value={`${speakerStats.length || 1} speaker${
                    speakerStats.length === 1 ? "" : "s"
                  }`}
                />
                <div className="flex items-center gap-2">
                  <dt className="sr-only">Status</dt>
                  <dd>
                    <StatusBadge
                      progress={meeting.transcriptionProgress}
                      status={meeting.status}
                    />
                  </dd>
                </div>
              </dl>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50">
                <span aria-hidden="true">↗</span>
                Share
              </button>
              <button
                aria-label="More meeting actions"
                className="inline-flex size-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-lg leading-none text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                …
              </button>
              <button className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm shadow-indigo-200 transition hover:bg-indigo-500">
                <span aria-hidden="true">↓</span>
                Export
              </button>
            </div>
          </div>
        </header>

        <div className="mt-5 overflow-x-auto border-b border-slate-200">
          <nav className="flex min-w-max gap-8 text-sm font-medium text-slate-600">
            {[
              "Overview",
              "Transcript",
              "Timeline",
              "Speakers",
              "Highlights",
              "Notes",
              "AI Chat",
            ].map((tab, index) => (
              <a
                className={`border-b-2 px-1 pb-4 transition ${
                  index === 0
                    ? "border-indigo-600 text-indigo-600"
                    : "border-transparent hover:border-slate-300 hover:text-slate-950"
                }`}
                href={`#${tab.toLowerCase().replaceAll(" ", "-")}`}
                key={tab}
              >
                {tab}
              </a>
            ))}
          </nav>
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <SummaryPanel summary={summary} status={meeting.status} />
            <AudioScrubber duration={formattedDuration} />
            <TranscriptPanel
              segments={transcriptSegments}
              status={meeting.status}
            />

            {meeting.status === "error" ? (
              <ErrorBlock meeting={meeting} />
            ) : null}

            <section className="rounded-lg border border-orange-200 bg-orange-50 p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-orange-950">
                    Delete meeting
                  </h2>
                  <p className="mt-1 text-sm text-orange-800">
                    Removes this meeting record and its stored audio artifacts.
                  </p>
                  {actionData?.ok === false &&
                  actionData.intent === "delete-meeting" ? (
                    <p className="mt-3 text-sm font-medium text-orange-800">
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
                    className="inline-flex h-10 items-center justify-center rounded-lg border border-orange-300 px-4 text-sm font-semibold text-orange-950 transition hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isDeleting || isUpdatingTitle}
                    type="submit"
                  >
                    {isDeleting ? "Deleting…" : "Delete meeting"}
                  </button>
                </Form>
              </div>
            </section>
          </div>

          <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
            <SpeakersPanel
              durationSeconds={meeting.durationSeconds}
              speakers={speakerStats}
            />
            <HighlightsPanel topics={keyTopics} />
            <NotesPanel summary={summary} uploadedLabel={uploadedLabel} />
            <PipelinePanel
              duration={formattedDuration}
              presentationLabel={presentation.label}
              uploadedLabel={formatUploadedAt(meeting.createdAt)}
            />
          </aside>
        </div>
      </div>
    </section>
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
      <p className="text-sm font-medium text-orange-800" id={feedbackId}>
        {actionData.error}
      </p>
    );
  }

  return (
    <p className="text-sm font-medium text-emerald-700" id={feedbackId}>
      Title saved as “{actionData.title}”.
    </p>
  );
}

function InlineMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-700">{value}</dd>
    </div>
  );
}

function AudioScrubber({ duration }: { duration: string }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm shadow-slate-100">
      <div className="flex items-center gap-4">
        <button
          aria-label="Play recording"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white shadow-sm shadow-indigo-200"
          type="button"
        >
          ▶
        </button>
        <span className="hidden text-sm font-medium text-slate-500 sm:inline">
          0:00
        </span>
        <div className="flex h-10 min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {Array.from({ length: 72 }).map((_, index) => (
            <span
              className={`w-0.5 shrink-0 rounded-full ${
                index < 8 ? "bg-indigo-500" : "bg-slate-300"
              }`}
              key={`waveform-${index}`}
              style={{ height: `${8 + ((index * 7) % 24)}px` }}
            />
          ))}
        </div>
        <span className="hidden text-sm font-medium text-slate-500 sm:inline">
          {duration}
        </span>
        <button
          className="hidden h-9 items-center justify-center rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700 sm:inline-flex"
          type="button"
        >
          1x
        </button>
      </div>
    </section>
  );
}

export function SummaryPanel({
  summary,
  status,
}: {
  summary: MeetingSummary | null;
  status: MeetingStatus;
}) {
  let emptyMessage = "Summary will appear here after summarization finishes.";

  if (status === "error") {
    emptyMessage = "No summary was saved before processing failed.";
  } else if (status === "done") {
    emptyMessage = "Summary is not available for this meeting.";
  }

  const keyTopics = getKeyTopics(summary, []);

  return (
    <article
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm shadow-slate-100 sm:p-6"
      id="overview"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="flex items-center gap-3 text-xl font-semibold text-slate-950">
          <span className="text-indigo-600" aria-hidden="true">
            ✦
          </span>
          Summary
        </h2>
        <button
          className="inline-flex h-10 w-fit items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-indigo-600 transition hover:bg-indigo-50"
          type="button"
        >
          ✎ Edit
        </button>
      </div>
      {summary === null ? (
        <p className="mt-3 text-sm leading-6 text-slate-600">{emptyMessage}</p>
      ) : (
        <div className="mt-4 space-y-5">
          <section>
            <h3 className="sr-only">Overview</h3>
            <p className="text-base leading-7 text-slate-800">
              {summary.overview}
            </p>
          </section>

          <div className="grid gap-5 border-t border-slate-200 pt-5 md:grid-cols-3">
            <SummaryList
              emptyText="No key topics recorded."
              items={keyTopics.map((topic, index) => ({
                id: `topic-${index}`,
                content: topic.label,
                meta: topic.timestamp,
              }))}
              marker="•"
              title="Key Topics"
            />

            <section>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                <span className="text-emerald-600" aria-hidden="true">
                  ✓
                </span>
                Action items
              </h3>
              {summary.actionItems.length === 0 ? (
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  No action items recorded.
                </p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {summary.actionItems.slice(0, 4).map((item, index) => (
                    <li className="flex gap-3" key={`action-item-${index}`}>
                      <span
                        aria-hidden="true"
                        className="mt-1 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[10px] text-white"
                      >
                        ✓
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm leading-5 text-slate-800">
                          {item.task}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Owner: {renderActionItemOwner(item.owner)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <SummaryList
              emptyText="No decisions recorded."
              items={summary.decisions.map((decision, index) => ({
                id: `decision-${index}`,
                content: decision.text,
              }))}
              marker="✓"
              title="Decisions"
            />
          </div>

          <SummaryList
            emptyText="No open questions recorded."
            items={summary.openQuestions.map((question, index) => ({
              id: `open-question-${index}`,
              content: question.text,
            }))}
            marker="?"
            title="Open questions"
          />
        </div>
      )}
    </article>
  );
}

function SummaryList({
  emptyText,
  items,
  marker = "•",
  title,
}: {
  emptyText: string;
  items: { content: string; id: string; meta?: string }[];
  marker?: string;
  title: string;
}) {
  return (
    <section>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
        <span className="text-indigo-600" aria-hidden="true">
          {marker}
        </span>
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-slate-600">{emptyText}</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {items.map((item) => (
            <li className="flex items-start gap-3 text-sm" key={item.id}>
              <span
                aria-hidden="true"
                className="mt-2 size-1.5 shrink-0 rounded-full bg-indigo-500"
              />
              <span className="min-w-0 flex-1 leading-5 text-slate-800">
                {item.content}
              </span>
              {item.meta ? (
                <span className="shrink-0 text-indigo-600">{item.meta}</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function renderActionItemOwner(owner: SummaryActionItemOwner) {
  if (owner.kind === "unknown") {
    return "Unassigned";
  }

  return owner.value;
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
    <article
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm shadow-slate-100 sm:p-5"
      id="transcript"
    >
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-3">
          <button
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            type="button"
          >
            Speakers
            <span aria-hidden="true">⌄</span>
          </button>
          <button
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            type="button"
          >
            Topics
            <span aria-hidden="true">⌄</span>
          </button>
        </div>
        <div className="flex min-w-0 gap-3">
          <div
            aria-label="Search transcript"
            className="flex h-10 min-w-0 flex-1 items-center rounded-lg border border-slate-200 px-3 text-sm text-slate-400 md:w-64"
            role="search"
          >
            Search transcript...
          </div>
          <button
            aria-label="Transcript filters"
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 transition hover:bg-slate-50"
            type="button"
          >
            ≡
          </button>
        </div>
      </div>

      <h2 className="sr-only">Transcript</h2>
      {segments.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-slate-600">{emptyMessage}</p>
      ) : (
        <ol className="mt-4 max-h-[34rem] space-y-5 overflow-y-auto pr-1">
          {segments.map((segment) => (
            <li className="flex gap-4" key={segment.id}>
              <SpeakerAvatar label={segment.speakerLabel} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="font-semibold text-slate-950">
                    {formatSpeakerLabel(segment.speakerLabel)}
                  </p>
                  <time className="text-sm font-medium text-indigo-600">
                    <span className="sr-only">
                      [{formatTranscriptTimestamp(segment.startSeconds)}]{" "}
                      {segment.speakerLabel}
                    </span>
                    <span aria-hidden="true">
                      {formatTranscriptTimestamp(segment.startSeconds)}
                    </span>
                  </time>
                </div>
                <p className="mt-1 text-sm leading-6 text-slate-800">
                  {segment.text}
                </p>
              </div>
              <button
                aria-label={`Actions for ${segment.speakerLabel} at ${formatTranscriptTimestamp(
                  segment.startSeconds,
                )}`}
                className="hidden size-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-700 sm:inline-flex"
                type="button"
              >
                ⋮
              </button>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function SpeakersPanel({
  durationSeconds,
  speakers,
}: {
  durationSeconds: number | null;
  speakers: SpeakerStat[];
}) {
  const visibleSpeakers =
    speakers.length > 0
      ? speakers
      : [{ durationSeconds: 0, label: "Speaker 1", percentage: 100 }];

  return (
    <aside className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm shadow-slate-100">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-950">Speakers</h2>
        <button
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          type="button"
        >
          <span aria-hidden="true">+</span>
          Add speaker
        </button>
      </div>
      <ol className="mt-5 space-y-4">
        {visibleSpeakers.slice(0, 6).map((speaker) => (
          <li
            className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 text-sm"
            key={speaker.label}
          >
            <SpeakerAvatar label={speaker.label} />
            <span className="min-w-0 truncate font-medium text-slate-950">
              {formatSpeakerLabel(speaker.label)}
            </span>
            <span className="text-slate-500">{speaker.percentage}%</span>
            <span className="hidden w-16 text-right text-slate-500 sm:inline">
              {durationSeconds === null
                ? "—"
                : formatDuration(Math.max(0, speaker.durationSeconds))}
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function HighlightsPanel({ topics }: { topics: TopicItem[] }) {
  const visibleTopics =
    topics.length > 0
      ? topics.slice(0, 3)
      : [
          {
            label: "Highlights will appear after summarization.",
            timestamp: "—",
          },
        ];

  return (
    <aside className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm shadow-slate-100">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-950">Highlights</h2>
        <button
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          type="button"
        >
          <span aria-hidden="true">+</span>
          Add highlight
        </button>
      </div>
      <ol className="mt-5 space-y-5">
        {visibleTopics.map((topic, index) => (
          <li className="grid grid-cols-[auto_1fr] gap-x-4" key={topic.label}>
            <span
              className={`mt-1 size-2.5 rounded-full ${
                index === 0
                  ? "bg-indigo-600"
                  : index === 1
                    ? "bg-emerald-500"
                    : "bg-orange-500"
              }`}
            />
            <div className="min-w-0">
              <div className="flex items-baseline gap-4">
                <time className="text-sm font-medium text-indigo-600">
                  {topic.timestamp}
                </time>
                <h3 className="font-semibold text-slate-950">{topic.label}</h3>
              </div>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {topic.description ?? "Captured from the meeting summary."}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function NotesPanel({
  summary,
  uploadedLabel,
}: {
  summary: MeetingSummary | null;
  uploadedLabel: string;
}) {
  return (
    <aside className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm shadow-slate-100">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-950">Notes</h2>
        <button
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          type="button"
        >
          <span aria-hidden="true">+</span>
          Add note
        </button>
      </div>
      <p className="mt-4 text-sm leading-6 text-slate-700">
        {summary?.openQuestions[0]?.text ??
          summary?.decisions[0]?.text ??
          "Notes can be added once the meeting has been reviewed."}
      </p>
      <p className="mt-4 text-xs text-slate-500">
        Created by you · {uploadedLabel}
      </p>
    </aside>
  );
}

function PipelinePanel({
  duration,
  presentationLabel,
  uploadedLabel,
}: {
  duration: string;
  presentationLabel: string;
  uploadedLabel: string;
}) {
  return (
    <aside className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm shadow-slate-100">
      <h2 className="text-base font-semibold text-slate-950">
        Meeting details
      </h2>
      <dl className="mt-4 grid gap-4 text-sm">
        <DetailField label="Status" value={presentationLabel} />
        <DetailField label="Duration" value={duration} />
        <DetailField label="Uploaded" value={uploadedLabel} />
      </dl>
    </aside>
  );
}

function SpeakerAvatar({ label }: { label: string }) {
  const initial = formatSpeakerLabel(label).charAt(0).toUpperCase() || "S";
  const colorIndex = Math.abs(hashString(label)) % speakerAvatarClasses.length;

  return (
    <span
      className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white ${speakerAvatarClasses[colorIndex]}`}
    >
      {initial}
    </span>
  );
}

type SpeakerStat = {
  durationSeconds: number;
  label: string;
  percentage: number;
};

type TopicItem = {
  description?: string;
  label: string;
  timestamp: string;
};

const speakerAvatarClasses = [
  "bg-indigo-600",
  "bg-emerald-600",
  "bg-orange-500",
  "bg-blue-500",
  "bg-pink-500",
  "bg-cyan-600",
] as const;

function getSpeakerStats(segments: TranscriptSegment[]) {
  const durationBySpeaker = new Map<string, number>();
  let totalDuration = 0;

  for (const segment of segments) {
    const duration = Math.max(0, segment.endSeconds - segment.startSeconds);
    totalDuration += duration;
    durationBySpeaker.set(
      segment.speakerLabel,
      (durationBySpeaker.get(segment.speakerLabel) ?? 0) + duration,
    );
  }

  return Array.from(durationBySpeaker.entries())
    .map(([label, durationSeconds]) => ({
      durationSeconds,
      label,
      percentage:
        totalDuration === 0
          ? 0
          : Math.round((durationSeconds / totalDuration) * 100),
    }))
    .sort((left, right) => right.durationSeconds - left.durationSeconds);
}

function getKeyTopics(
  summary: MeetingSummary | null,
  segments: TranscriptSegment[],
): TopicItem[] {
  if (summary === null) {
    return [];
  }

  const transcriptTimes = segments
    .slice(0, 6)
    .map((segment) => formatTranscriptTimestamp(segment.startSeconds));

  const decisions = summary.decisions.slice(0, 3).map((decision, index) => ({
    description: decision.text,
    label: summarizeTopicLabel(decision.text),
    timestamp: transcriptTimes[index] ?? `${(index + 1) * 8}:10`,
  }));

  if (decisions.length > 0) {
    return decisions;
  }

  return summary.actionItems.slice(0, 3).map((item, index) => ({
    description: item.task,
    label: summarizeTopicLabel(item.task),
    timestamp: transcriptTimes[index] ?? `${(index + 1) * 8}:10`,
  }));
}

function summarizeTopicLabel(text: string) {
  const normalizedText = text.trim().replace(/\s+/g, " ");

  if (normalizedText.length <= 32) {
    return normalizedText;
  }

  return `${normalizedText.slice(0, 29).trim()}...`;
}

function formatSpeakerLabel(label: string) {
  const normalizedLabel = label.trim();
  const speakerMatch = /^SPEAKER[_ -]?(\d+)$/i.exec(normalizedLabel);

  if (speakerMatch) {
    return `Speaker ${Number(speakerMatch[1]) + 1}`;
  }

  return normalizedLabel || "Speaker";
}

function hashString(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return hash;
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-slate-500 uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium text-slate-800">{value}</dd>
    </div>
  );
}

function ErrorBlock({ meeting }: { meeting: MeetingDetail }) {
  return (
    <div className="rounded-lg border border-orange-200 bg-orange-50 p-5">
      <h2 className="text-lg font-semibold text-orange-900">
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
          <dt className="text-xs font-semibold tracking-[0.2em] text-orange-700 uppercase">
            Error message
          </dt>
          <dd className="mt-2 text-orange-900">
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
    active: "border-indigo-200 bg-indigo-50 text-indigo-800",
    danger: "border-orange-200 bg-orange-50 text-orange-800",
    queued: "border-slate-200 bg-slate-100 text-slate-700",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
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

function formatMeetingDate(createdAt: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(createdAt));
}
