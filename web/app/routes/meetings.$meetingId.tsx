import { useCallback, useEffect, useRef, useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useFetcher,
  useNavigation,
  useRevalidator,
} from "react-router";
import { Icon } from "~/components/app-icons";
import type {
  MeetingStatus,
  SummaryActionItem,
  SummaryActionItemOwner,
} from "~/db/schema";
import type { MeetingDetailActionData as MeetingActionData } from "~/lib/meeting-detail-action.server";
import {
  applySpeakerMap,
  createSpeakerMap,
  formatDuration,
  formatTranscriptTimestamp,
  getMeetingStatusPresentation,
  isTerminalMeetingStatus,
  type MeetingDetail,
  type MeetingStatusTone,
  type MeetingSummary,
  type SpeakerMap,
  type TranscriptSegment,
} from "~/lib/meetings-list";
import type { Route } from "./+types/meetings.$meetingId";

const cardClass =
  "rounded-2xl border border-hairline bg-surface p-6 shadow-[0_1px_0_rgba(28,27,24,0.04),0_18px_40px_-24px_rgba(28,27,24,0.12)] sm:p-8";

const railCardClass =
  "rounded-2xl border border-hairline bg-surface p-6 shadow-[0_1px_0_rgba(28,27,24,0.04),0_18px_40px_-24px_rgba(28,27,24,0.12)]";

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
  const { meeting, speakerMappings, summary, transcriptSegments } = loaderData;
  const actionData = useActionData<MeetingActionData>();
  const navigation = useNavigation();
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(meeting.title);
  const [titleFeedback, setTitleFeedback] = useState<MeetingActionData>();
  const [speakerMap, setSpeakerMap] = useState<
    Record<string, string | undefined>
  >(() => ({ ...createSpeakerMap(speakerMappings) }));
  const [persistedSpeakerMap, setPersistedSpeakerMap] = useState<
    Record<string, string | undefined>
  >(() => ({ ...createSpeakerMap(speakerMappings) }));
  const [protectedSpeakerLabels, setProtectedSpeakerLabels] = useState<
    Record<string, true | undefined>
  >({});
  const { revalidate } = useRevalidator();

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
      ? "Not available"
      : formatDuration(meeting.durationSeconds);
  const titleFeedbackId = "meeting-title-feedback";
  const uploadedLabel = formatMeetingDate(meeting.createdAt);
  const speakerStats = getSpeakerStats(transcriptSegments);
  const keyTopics = getKeyTopics(summary, transcriptSegments, speakerMap);

  useEffect(() => {
    const nextPersistedSpeakerMap = { ...createSpeakerMap(speakerMappings) };

    setPersistedSpeakerMap((currentPersistedSpeakerMap) => {
      const mergedPersistedSpeakerMap = { ...nextPersistedSpeakerMap };

      for (const speakerLabel of Object.keys(protectedSpeakerLabels)) {
        mergedPersistedSpeakerMap[speakerLabel] =
          currentPersistedSpeakerMap[speakerLabel];
      }

      return mergedPersistedSpeakerMap;
    });

    setSpeakerMap((currentSpeakerMap) => {
      const mergedSpeakerMap = { ...nextPersistedSpeakerMap };

      for (const [speakerLabel, speakerName] of Object.entries(
        currentSpeakerMap,
      )) {
        if (protectedSpeakerLabels[speakerLabel]) {
          mergedSpeakerMap[speakerLabel] = speakerName;
        }
      }

      return mergedSpeakerMap;
    });
  }, [protectedSpeakerLabels, speakerMappings]);

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

  const updateSpeakerName = useCallback(
    (speakerLabel: string, name: string) => {
      setSpeakerMap((currentSpeakerMap) => ({
        ...currentSpeakerMap,
        [speakerLabel]: name,
      }));
    },
    [],
  );

  const persistSpeakerName = useCallback(
    (speakerLabel: string, name: string | null) => {
      setPersistedSpeakerMap((currentSpeakerMap) => ({
        ...currentSpeakerMap,
        [speakerLabel]: name ?? undefined,
      }));
      setSpeakerMap((currentSpeakerMap) => ({
        ...currentSpeakerMap,
        [speakerLabel]: name ?? undefined,
      }));
    },
    [],
  );

  const protectSpeakerEdit = useCallback((speakerLabel: string) => {
    setProtectedSpeakerLabels((currentProtectedSpeakerLabels) => ({
      ...currentProtectedSpeakerLabels,
      [speakerLabel]: true,
    }));
  }, []);

  const unprotectSpeakerEdit = useCallback((speakerLabel: string) => {
    setProtectedSpeakerLabels((currentProtectedSpeakerLabels) => {
      const nextProtectedSpeakerLabels = { ...currentProtectedSpeakerLabels };
      delete nextProtectedSpeakerLabels[speakerLabel];
      return nextProtectedSpeakerLabels;
    });
  }, []);

  return (
    <section className="text-ink min-w-0 flex-1">
      <div className="border-hairline border-b">
        <header className="mx-auto w-full max-w-[1500px] px-4 pt-5 pb-5 sm:px-6 lg:px-10 lg:pt-7 lg:pb-6">
          <div className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            <Link
              className="hover:text-ink inline-flex items-center gap-1 font-medium transition"
              to="/"
            >
              <Icon name="chevron-left" className="size-3.5" />
              Back to meetings
            </Link>
            <MetaSeparator />
            <span aria-label={`Uploaded ${uploadedLabel}`}>
              {uploadedLabel}
            </span>
            <MetaSeparator />
            <span
              aria-label={`Duration ${formattedDuration}`}
              className="font-mono tabular-nums"
            >
              {formattedDuration}
            </span>
            <MetaSeparator />
            <span>
              {speakerStats.length}{" "}
              {speakerStats.length === 1 ? "speaker" : "speakers"}
            </span>
          </div>

          {isEditingTitle ? (
            <div className="mt-3">
              <TitleEditor
                draft={titleDraft}
                feedback={titleFeedback}
                feedbackId={titleFeedbackId}
                isDeleting={isDeleting}
                isUpdatingTitle={isUpdatingTitle}
                onCancel={cancelTitleEdit}
                onChange={setTitleDraft}
              />
            </div>
          ) : (
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <TitleDisplay
                feedback={titleFeedback}
                feedbackId={titleFeedbackId}
                isDisabled={isDeleting || isUpdatingTitle}
                onBeginEdit={beginTitleEdit}
                title={meeting.title}
              />
              <StatusBadge
                progress={meeting.transcriptionProgress}
                status={meeting.status}
              />
            </div>
          )}
        </header>
      </div>

      <div className="px-4 pt-8 pb-6 sm:px-6 lg:px-10 lg:pb-10">
        <div className="mx-auto grid w-full max-w-[1500px] gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-6">
            <SummaryPanel
              speakerMap={speakerMap}
              status={meeting.status}
              summary={summary}
            />
            <TranscriptPanel
              segments={transcriptSegments}
              speakerMap={speakerMap}
              status={meeting.status}
            />
            {meeting.status === "error" ? (
              <ErrorBlock meeting={meeting} />
            ) : null}
            <DangerZone
              actionData={actionData}
              isDeleting={isDeleting}
              isUpdatingTitle={isUpdatingTitle}
            />
          </div>

          <aside className="space-y-6 xl:sticky xl:top-6 xl:self-start">
            <ProcessingPanel
              failedAtStage={meeting.failedAtStage}
              progress={meeting.transcriptionProgress}
              status={meeting.status}
            />
            <SpeakersPanel
              durationSeconds={meeting.durationSeconds}
              onSpeakerNameChange={updateSpeakerName}
              onSpeakerNamePersist={persistSpeakerName}
              onSpeakerNameProtect={protectSpeakerEdit}
              onSpeakerNameUnprotect={unprotectSpeakerEdit}
              persistedSpeakerMap={persistedSpeakerMap}
              speakerMap={speakerMap}
              speakers={speakerStats}
            />
            <HighlightsPanel topics={keyTopics} />
          </aside>
        </div>
      </div>
    </section>
  );
}

function TitleDisplay({
  feedback,
  feedbackId,
  isDisabled,
  onBeginEdit,
  title,
}: {
  feedback: MeetingActionData | undefined;
  feedbackId: string;
  isDisabled: boolean;
  onBeginEdit: () => void;
  title: string;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="group flex flex-wrap items-center gap-x-2 gap-y-1">
        <h1 className="font-display text-ink min-w-0 text-[1.875rem] leading-[1.05] font-medium tracking-[-0.015em] sm:text-[2.25rem]">
          {title}
        </h1>
        <button
          aria-label="Edit meeting title"
          className="text-ink-subtle hover:bg-surface-sunken hover:text-ink-soft focus-visible:bg-surface-sunken focus-visible:text-ink-soft inline-flex size-7 shrink-0 items-center justify-center rounded-md opacity-40 transition group-focus-within:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
          disabled={isDisabled}
          onClick={onBeginEdit}
          type="button"
        >
          <Icon className="size-3.5" name="pencil" />
        </button>
      </div>
      <TitleFeedback actionData={feedback} feedbackId={feedbackId} />
    </div>
  );
}

function TitleEditor({
  draft,
  feedback,
  feedbackId,
  isDeleting,
  isUpdatingTitle,
  onCancel,
  onChange,
}: {
  draft: string;
  feedback: MeetingActionData | undefined;
  feedbackId: string;
  isDeleting: boolean;
  isUpdatingTitle: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
}) {
  const isInvalid =
    feedback?.intent === "update-title" && feedback.ok === false;
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <Form className="space-y-3" method="post" preventScrollReset>
      <input name="_intent" type="hidden" value="update-title" />
      <label className="sr-only" htmlFor="meeting-title">
        Meeting title
      </label>
      <div className="flex flex-col gap-3 md:flex-row">
        <input
          aria-describedby={feedbackId}
          aria-invalid={isInvalid ? true : undefined}
          className="font-display border-hairline-strong bg-surface-elevated text-ink placeholder:text-ink-subtle focus:border-brand min-w-0 flex-1 rounded-xl border px-4 py-3 text-[1.875rem] leading-[1.1] font-medium tracking-[-0.015em] transition outline-none sm:text-[2.25rem]"
          disabled={isDeleting || isUpdatingTitle}
          id="meeting-title"
          maxLength={200}
          name="title"
          onChange={(event) => onChange(event.target.value)}
          ref={inputRef}
          required
          value={draft}
        />
        <div className="flex gap-2">
          <button
            className="bg-brand text-canvas hover:bg-brand-deep inline-flex h-11 items-center justify-center rounded-lg px-4 text-sm font-medium shadow-[0_10px_24px_-8px_rgba(63,90,48,0.45)] transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isDeleting || isUpdatingTitle}
            type="submit"
          >
            {isUpdatingTitle ? "Saving…" : "Save"}
          </button>
          <button
            className="border-hairline text-ink-soft hover:bg-surface-sunken inline-flex h-11 items-center justify-center rounded-lg border px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isUpdatingTitle}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
      <TitleFeedback actionData={feedback} feedbackId={feedbackId} />
    </Form>
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
      <p className="text-danger text-sm font-medium" id={feedbackId}>
        {actionData.error}
      </p>
    );
  }

  return (
    <p className="text-success text-sm font-medium" id={feedbackId}>
      Title saved as “{actionData.title}”.
    </p>
  );
}

function MetaSeparator() {
  return (
    <span aria-hidden="true" className="text-ink-subtle/70 select-none">
      ·
    </span>
  );
}

export function SummaryPanel({
  speakerMap = {},
  summary,
  status,
}: {
  speakerMap?: SpeakerMap;
  summary: MeetingSummary | null;
  status: MeetingStatus;
}) {
  let emptyMessage = "Summary will appear here after summarization finishes.";

  if (status === "error") {
    emptyMessage = "No summary was saved before processing failed.";
  } else if (status === "done") {
    emptyMessage = "Summary is not available for this meeting.";
  }

  const keyTopics = getKeyTopics(summary, [], speakerMap);

  return (
    <article className={cardClass} id="overview">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="font-display text-ink text-2xl font-medium tracking-tight">
          Summary
        </h2>
        <span
          aria-hidden="true"
          className="bg-hairline hidden h-px flex-1 sm:block"
        />
        <span className="text-ink-muted font-mono text-[11px] tracking-[0.06em] uppercase">
          Auto-generated
        </span>
      </header>

      {summary === null ? (
        <EmptyState>{emptyMessage}</EmptyState>
      ) : (
        <div className="mt-6 space-y-7">
          <section>
            <h3 className="sr-only">Overview</h3>
            <p className="text-ink-soft text-base leading-7">
              {applySpeakerMap(summary.overview, speakerMap)}
            </p>
          </section>

          <div className="border-hairline grid gap-7 border-t pt-7 md:grid-cols-3">
            <SummaryList
              emptyText="No key topics recorded."
              items={keyTopics.map((topic, index) => ({
                content: topic.label,
                id: `topic-${index}`,
                meta: topic.timestamp,
              }))}
              title="Key topics"
            />
            <ActionItemsList
              items={summary.actionItems}
              speakerMap={speakerMap}
            />
            <SummaryList
              emptyText="No decisions recorded."
              items={summary.decisions.map((decision, index) => ({
                content: applySpeakerMap(decision.text, speakerMap),
                id: `decision-${index}`,
              }))}
              title="Decisions"
            />
          </div>

          <SummaryList
            emptyText="No open questions recorded."
            items={summary.openQuestions.map((question, index) => ({
              content: applySpeakerMap(question.text, speakerMap),
              id: `open-question-${index}`,
            }))}
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
  title,
}: {
  emptyText: string;
  items: { content: string; id: string; meta?: string }[];
  title: string;
}) {
  return (
    <section>
      <h3 className="text-ink text-sm font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className="text-ink-muted mt-3 text-sm leading-6">{emptyText}</p>
      ) : (
        <ol className="mt-3 space-y-2.5">
          {items.map((item) => (
            <li
              className="flex items-start gap-2.5 text-sm leading-6"
              key={item.id}
            >
              <span
                aria-hidden="true"
                className="bg-brand mt-2 size-1 shrink-0 rounded-full"
              />
              <span className="text-ink-soft min-w-0 flex-1">
                {item.content}
              </span>
              {item.meta ? (
                <span className="text-ink-muted shrink-0 font-mono text-[11px] tabular-nums">
                  {item.meta}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ActionItemsList({
  items,
  speakerMap,
}: {
  items: SummaryActionItem[];
  speakerMap: SpeakerMap;
}) {
  return (
    <section>
      <h3 className="text-ink text-sm font-medium">Action items</h3>
      {items.length === 0 ? (
        <p className="text-ink-muted mt-3 text-sm leading-6">
          No action items recorded.
        </p>
      ) : (
        <ol className="mt-3 space-y-3">
          {items.slice(0, 4).map((item, index) => (
            <li className="flex gap-2.5" key={`action-item-${index}`}>
              <span
                aria-hidden="true"
                className="bg-success-soft text-success mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full"
              >
                <Icon className="size-2.5" name="check" />
              </span>
              <div className="min-w-0">
                <p className="text-ink-soft text-sm leading-5">
                  {applySpeakerMap(item.task, speakerMap)}
                </p>
                <p className="text-ink-muted mt-1 text-xs">
                  Owner: {renderActionItemOwner(item.owner, speakerMap)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function renderActionItemOwner(
  owner: SummaryActionItemOwner,
  speakerMap: SpeakerMap,
) {
  if (owner.kind === "unknown") {
    return "Unassigned";
  }

  if (owner.kind === "speaker") {
    return applySpeakerMap(owner.value, speakerMap);
  }

  return owner.value;
}

export function TranscriptPanel({
  segments,
  speakerMap = {},
  status,
}: {
  segments: TranscriptSegment[];
  speakerMap?: SpeakerMap;
  status: MeetingStatus;
}) {
  let emptyMessage = "Transcript will appear here when transcription finishes.";

  if (status === "error") {
    emptyMessage = "No transcript was saved before processing failed.";
  } else if (status === "done") {
    emptyMessage = "Transcript is not available for this meeting.";
  }

  return (
    <article className={cardClass} id="transcript">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="font-display text-ink text-2xl font-medium tracking-tight">
          Transcript
        </h2>
        <span
          aria-hidden="true"
          className="bg-hairline hidden h-px flex-1 sm:block"
        />
        {segments.length > 0 ? (
          <span className="text-ink-muted font-mono text-[11px] tracking-[0.06em] uppercase tabular-nums">
            {segments.length} segment{segments.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </header>

      {segments.length === 0 ? (
        <EmptyState>{emptyMessage}</EmptyState>
      ) : (
        <ol className="mt-6 max-h-[40rem] space-y-6 overflow-y-auto pr-1">
          {segments.map((segment) => {
            const speakerName = applySpeakerMap(
              segment.speakerLabel,
              speakerMap,
            );

            return (
              <li className="flex gap-4" key={segment.id}>
                <SpeakerAvatar label={segment.speakerLabel} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <p className="text-ink text-sm font-medium">
                      {speakerName}
                    </p>
                    <time className="bg-canvas text-ink-muted rounded-md px-1.5 py-0.5 font-mono text-[11px] tabular-nums">
                      <span className="sr-only">
                        [{formatTranscriptTimestamp(segment.startSeconds)}]{" "}
                        {speakerName}
                      </span>
                      <span aria-hidden="true">
                        {formatTranscriptTimestamp(segment.startSeconds)}
                      </span>
                    </time>
                  </div>
                  <p className="text-ink-soft mt-1.5 text-sm leading-[1.7]">
                    {segment.text}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}

const PIPELINE_STAGES: Array<{
  description: string;
  id: MeetingStatus;
  label: string;
}> = [
  {
    description: "Preparing audio file",
    id: "normalizing",
    label: "Normalize audio",
  },
  {
    description: "Generating transcript",
    id: "transcribing",
    label: "Transcribe",
  },
  {
    description: "Clustering voices",
    id: "diarizing",
    label: "Identify speakers",
  },
  {
    description: "Extracting key moments",
    id: "summarizing",
    label: "Summarize",
  },
];

type StageState = "complete" | "active" | "pending" | "failed";

function ProcessingPanel({
  failedAtStage,
  progress,
  status,
}: {
  failedAtStage: MeetingStatus | null;
  progress: number | null;
  status: MeetingStatus;
}) {
  const stageState = (index: number): StageState => {
    if (status === "done") {
      return "complete";
    }

    if (status === "error") {
      const failedIndex = failedAtStage
        ? PIPELINE_STAGES.findIndex((stage) => stage.id === failedAtStage)
        : -1;

      if (failedIndex >= 0) {
        if (index < failedIndex) return "complete";
        if (index === failedIndex) return "failed";
        return "pending";
      }

      return index === 0 ? "failed" : "pending";
    }

    if (status === "pending") {
      return "pending";
    }

    const currentIndex = PIPELINE_STAGES.findIndex(
      (stage) => stage.id === status,
    );

    if (currentIndex < 0) return "pending";
    if (index < currentIndex) return "complete";
    if (index === currentIndex) return "active";
    return "pending";
  };

  return (
    <aside className={railCardClass}>
      <header className="flex items-center justify-between gap-3">
        <h2 className="font-display text-ink text-lg font-medium tracking-tight">
          Processing
        </h2>
        {status === "transcribing" && progress !== null ? (
          <span className="text-brand font-mono text-[11px] tabular-nums">
            {progress}%
          </span>
        ) : status === "pending" ? (
          <span className="text-ink-muted font-mono text-[11px] tracking-[0.06em] uppercase">
            Queued
          </span>
        ) : null}
      </header>
      <ol className="before:bg-hairline relative mt-5 space-y-4 before:absolute before:top-2 before:bottom-2 before:left-[7px] before:w-px">
        {PIPELINE_STAGES.map((stage, index) => {
          const state = stageState(index);

          return (
            <li
              className="relative grid grid-cols-[auto_1fr] items-start gap-x-3"
              key={stage.id}
            >
              <StageIndicator state={state} />
              <div className="min-w-0">
                <p
                  className={`text-sm font-medium ${
                    state === "active"
                      ? "text-brand"
                      : state === "failed"
                        ? "text-danger"
                        : state === "complete"
                          ? "text-ink"
                          : "text-ink-muted"
                  }`}
                >
                  {stage.label}
                </p>
                {state === "active" || state === "failed" ? (
                  <p className="text-ink-muted mt-0.5 text-xs">
                    {stage.description}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function StageIndicator({ state }: { state: StageState }) {
  if (state === "complete") {
    return (
      <span className="bg-success text-canvas ring-surface relative z-[1] flex size-4 shrink-0 items-center justify-center rounded-full ring-4">
        <Icon className="size-2.5" name="check" />
      </span>
    );
  }

  if (state === "active") {
    return (
      <span
        aria-hidden="true"
        className="bg-brand-soft ring-surface relative z-[1] flex size-4 shrink-0 items-center justify-center rounded-full ring-4"
      >
        <span className="bg-brand size-2 animate-pulse rounded-full" />
      </span>
    );
  }

  if (state === "failed") {
    return (
      <span className="bg-danger text-canvas ring-surface relative z-[1] flex size-4 shrink-0 items-center justify-center rounded-full ring-4">
        <Icon className="size-2.5" name="alert" />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="border-hairline-strong bg-surface ring-surface relative z-[1] size-4 shrink-0 rounded-full border ring-4"
    />
  );
}

export function SpeakersPanel({
  durationSeconds,
  onSpeakerNameChange,
  onSpeakerNamePersist,
  onSpeakerNameProtect,
  onSpeakerNameUnprotect,
  persistedSpeakerMap,
  speakerMap,
  speakers,
}: {
  durationSeconds: number | null;
  onSpeakerNameChange: (speakerLabel: string, name: string) => void;
  onSpeakerNamePersist: (speakerLabel: string, name: string | null) => void;
  onSpeakerNameProtect: (speakerLabel: string) => void;
  onSpeakerNameUnprotect: (speakerLabel: string) => void;
  persistedSpeakerMap: SpeakerMap;
  speakerMap: SpeakerMap;
  speakers: SpeakerStat[];
}) {
  return (
    <aside className={railCardClass}>
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-ink text-lg font-medium tracking-tight">
            Speakers
          </h2>
          <p className="text-ink-muted mt-1 text-xs leading-5">
            Map diarized labels to names. Saves on blur.
          </p>
        </div>
        <span className="text-ink-muted font-mono text-[11px] tracking-[0.06em] uppercase tabular-nums">
          {speakers.length}
        </span>
      </header>
      {speakers.length === 0 ? (
        <p className="text-ink-muted mt-4 text-sm leading-6">
          Speakers appear after diarization creates transcript labels.
        </p>
      ) : (
        <ol className="mt-5 space-y-4">
          {speakers.map((speaker) => (
            <SpeakerMappingRow
              durationSeconds={durationSeconds}
              key={speaker.label}
              onNameChange={onSpeakerNameChange}
              onNamePersist={onSpeakerNamePersist}
              onNameProtect={onSpeakerNameProtect}
              onNameUnprotect={onSpeakerNameUnprotect}
              persistedName={persistedSpeakerMap[speaker.label] ?? ""}
              speaker={speaker}
              value={speakerMap[speaker.label] ?? ""}
            />
          ))}
        </ol>
      )}
    </aside>
  );
}

function SpeakerMappingRow({
  durationSeconds,
  onNameChange,
  onNamePersist,
  onNameProtect,
  onNameUnprotect,
  persistedName,
  speaker,
  value,
}: {
  durationSeconds: number | null;
  onNameChange: (speakerLabel: string, name: string) => void;
  onNamePersist: (speakerLabel: string, name: string | null) => void;
  onNameProtect: (speakerLabel: string) => void;
  onNameUnprotect: (speakerLabel: string) => void;
  persistedName: string;
  speaker: SpeakerStat;
  value: string;
}) {
  const fetcher = useFetcher<MeetingActionData>();
  const feedback = fetcher.data;
  const lastProcessedFeedbackRef = useRef<typeof feedback>(undefined);
  const feedbackId = `speaker-mapping-${speaker.label}-feedback`;
  const isSaving = fetcher.state !== "idle";
  const error =
    feedback?.intent === "save-speaker-mapping" &&
    feedback.ok === false &&
    feedback.speakerLabel === speaker.label
      ? feedback.error
      : null;

  useEffect(() => {
    if (feedback === lastProcessedFeedbackRef.current) {
      return;
    }

    if (
      feedback?.intent === "save-speaker-mapping" &&
      feedback.speakerLabel === speaker.label
    ) {
      lastProcessedFeedbackRef.current = feedback;

      if (feedback.ok) {
        onNamePersist(feedback.speakerLabel, feedback.name);
        onNameUnprotect(speaker.label);
      }
    }
  }, [feedback, onNamePersist, onNameUnprotect, speaker.label]);

  return (
    <li className="space-y-2 text-sm">
      <fetcher.Form method="post" preventScrollReset>
        <input name="_intent" type="hidden" value="save-speaker-mapping" />
        <input name="speakerLabel" type="hidden" value={speaker.label} />
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
          <SpeakerAvatar label={speaker.label} />
          <div className="min-w-0 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label
                className="text-ink min-w-0 truncate font-medium"
                htmlFor={`speaker-mapping-${speaker.label}`}
              >
                {speaker.label}
              </label>
              <span className="text-ink-muted shrink-0 font-mono text-xs tabular-nums">
                {speaker.percentage}% ·{" "}
                {durationSeconds === null
                  ? "—"
                  : formatDuration(Math.max(0, speaker.durationSeconds))}
              </span>
            </div>
            <input
              aria-describedby={feedbackId}
              aria-invalid={error ? true : undefined}
              className="border-hairline bg-surface-elevated text-ink placeholder:text-ink-subtle focus:border-brand w-full rounded-lg border px-3 py-2 text-sm transition outline-none disabled:cursor-wait disabled:opacity-70"
              disabled={isSaving}
              id={`speaker-mapping-${speaker.label}`}
              maxLength={100}
              name="name"
              onBlur={(event) => {
                const trimmedValue = event.currentTarget.value.trim();

                if (trimmedValue === persistedName.trim()) {
                  onNameUnprotect(speaker.label);
                  return;
                }

                if (event.currentTarget.form) {
                  onNameProtect(speaker.label);
                  fetcher.submit(event.currentTarget.form);
                }
              }}
              onChange={(event) =>
                onNameChange(speaker.label, event.target.value)
              }
              onFocus={() => onNameProtect(speaker.label)}
              placeholder="Add name"
              type="text"
              value={value}
            />
            <p
              className={
                error ? "text-danger text-xs" : "text-ink-muted text-xs"
              }
              id={feedbackId}
            >
              {error ?? (isSaving ? "Saving…" : "Blur to save")}
            </p>
          </div>
        </div>
      </fetcher.Form>
    </li>
  );
}

function HighlightsPanel({ topics }: { topics: TopicItem[] }) {
  if (topics.length === 0) {
    return (
      <aside className={railCardClass}>
        <header className="flex items-center justify-between gap-3">
          <h2 className="font-display text-ink text-lg font-medium tracking-tight">
            Key moments
          </h2>
        </header>
        <p className="text-ink-muted mt-4 text-sm leading-6">
          Highlights appear once summarization completes.
        </p>
      </aside>
    );
  }

  const dotColors = ["bg-brand", "bg-accent", "bg-warning", "bg-success"];

  return (
    <aside className={railCardClass}>
      <header className="flex items-center justify-between gap-3">
        <h2 className="font-display text-ink text-lg font-medium tracking-tight">
          Key moments
        </h2>
        <span className="text-ink-muted font-mono text-[11px] tracking-[0.06em] uppercase tabular-nums">
          {topics.length}
        </span>
      </header>
      <ol className="before:bg-hairline-strong relative mt-5 space-y-5 before:absolute before:top-3 before:bottom-3 before:left-[5px] before:w-px">
        {topics.slice(0, 4).map((topic, index) => (
          <li
            className="relative grid grid-cols-[auto_1fr] items-start gap-x-4"
            key={topic.label}
          >
            <span
              aria-hidden="true"
              className={`ring-surface relative z-[1] mt-1.5 size-2.5 rounded-full ring-4 ${
                dotColors[index % dotColors.length]
              }`}
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <time className="text-ink-muted font-mono text-[11px] tabular-nums">
                  {topic.timestamp}
                </time>
                <h3 className="text-ink text-sm font-medium">{topic.label}</h3>
              </div>
              {topic.description ? (
                <p className="text-ink-muted mt-1 text-xs leading-5">
                  {topic.description}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function DangerZone({
  actionData,
  isDeleting,
  isUpdatingTitle,
}: {
  actionData: MeetingActionData | undefined;
  isDeleting: boolean;
  isUpdatingTitle: boolean;
}) {
  const error =
    actionData?.ok === false && actionData.intent === "delete-meeting"
      ? actionData.error
      : null;

  return (
    <section className={cardClass}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-ink text-base font-medium">
            Delete this meeting
          </h2>
          <p className="text-ink-muted mt-1 text-sm leading-6">
            Removes the meeting record and stored audio artifacts. This cannot
            be undone.
          </p>
          {error ? (
            <p className="text-danger mt-3 text-sm font-medium">{error}</p>
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
            className="border-danger/30 text-danger hover:border-danger hover:bg-danger hover:text-canvas inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium whitespace-nowrap transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isDeleting || isUpdatingTitle}
            type="submit"
          >
            <Icon className="size-4" name="trash" />
            {isDeleting ? "Deleting…" : "Delete meeting"}
          </button>
        </Form>
      </div>
    </section>
  );
}

function ErrorBlock({ meeting }: { meeting: MeetingDetail }) {
  return (
    <div className="border-danger/25 bg-danger-soft/40 rounded-2xl border p-6 sm:p-8">
      <div className="flex items-start gap-3">
        <span className="bg-danger text-canvas mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full">
          <Icon className="size-4" name="alert" />
        </span>
        <div>
          <h2 className="font-display text-danger text-xl font-medium tracking-tight">
            Processing failed
          </h2>
          <p className="text-ink-soft mt-1 text-sm">
            The pipeline could not complete. Diagnostic details below.
          </p>
        </div>
      </div>
      <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
        <DetailField
          label="Error kind"
          value={meeting.errorKind ?? "Unknown"}
        />
        <DetailField
          label="Failed at stage"
          value={meeting.failedAtStage ?? "Unknown"}
        />
        <div className="sm:col-span-2">
          <dt className="text-ink-muted font-mono text-[11px] tracking-[0.08em] uppercase">
            Error message
          </dt>
          <dd className="border-danger/15 bg-canvas text-ink-soft mt-2 rounded-lg border p-3 font-mono text-xs leading-relaxed">
            {meeting.errorMessage ?? "No error message was recorded."}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-muted font-mono text-[11px] tracking-[0.08em] uppercase">
        {label}
      </dt>
      <dd className="text-ink mt-1 text-sm font-medium">{value}</dd>
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
    active: "border-brand/20 bg-brand-soft text-brand",
    danger: "border-danger/25 bg-danger-soft text-danger",
    queued: "border-hairline bg-surface-sunken text-ink-soft",
    success: "border-success/25 bg-success-soft text-success",
  };

  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-[0.06em] uppercase ${toneStyles[presentation.tone]}`}
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

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-hairline-strong bg-canvas/50 mt-6 rounded-xl border border-dashed px-5 py-8 text-center">
      <p className="text-ink-muted text-sm leading-6">{children}</p>
    </div>
  );
}

function SpeakerAvatar({ label }: { label: string }) {
  const initial = formatSpeakerLabel(label).charAt(0).toUpperCase() || "S";
  const colorIndex = Math.abs(hashString(label)) % speakerAvatarClasses.length;

  return (
    <span
      className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-medium ${speakerAvatarClasses[colorIndex]}`}
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
  "bg-brand-soft text-brand",
  "bg-success-soft text-success",
  "bg-accent-soft text-accent-deep",
  "bg-warning-soft text-warning",
  "bg-[#e3dde9] text-[#5e4a73]",
  "bg-[#dbdfe6] text-[#3b4860]",
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
    .sort((left, right) => compareSpeakerLabels(left.label, right.label));
}

function compareSpeakerLabels(leftLabel: string, rightLabel: string) {
  const leftMatch = /^SPEAKER_(\d+)$/.exec(leftLabel);
  const rightMatch = /^SPEAKER_(\d+)$/.exec(rightLabel);

  if (leftMatch && rightMatch) {
    return Number(leftMatch[1]) - Number(rightMatch[1]);
  }

  return leftLabel.localeCompare(rightLabel);
}

function getKeyTopics(
  summary: MeetingSummary | null,
  segments: TranscriptSegment[],
  speakerMap: SpeakerMap = {},
): TopicItem[] {
  if (summary === null) {
    return [];
  }

  const transcriptTimes = segments
    .slice(0, 6)
    .map((segment) => formatTranscriptTimestamp(segment.startSeconds));

  const decisions = summary.decisions.slice(0, 3).map((decision, index) => {
    const mappedText = applySpeakerMap(decision.text, speakerMap);

    return {
      description: mappedText,
      label: summarizeTopicLabel(mappedText),
      timestamp: transcriptTimes[index] ?? `${(index + 1) * 8}:10`,
    };
  });

  if (decisions.length > 0) {
    return decisions;
  }

  return summary.actionItems.slice(0, 3).map((item, index) => {
    const mappedTask = applySpeakerMap(item.task, speakerMap);

    return {
      description: mappedTask,
      label: summarizeTopicLabel(mappedTask),
      timestamp: transcriptTimes[index] ?? `${(index + 1) * 8}:10`,
    };
  });
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

function formatMeetingDate(createdAt: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(createdAt));
}
