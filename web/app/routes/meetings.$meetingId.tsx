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
import type { MeetingStatus, SummaryRegenerationStatus } from "~/db/schema";
import type { MeetingDetailActionData as MeetingActionData } from "~/lib/meeting-detail-action.server";
import type { MeetingExportFlavor } from "~/lib/meeting-export";
import {
  formatMeetingLanguageLabel,
  languageToFormValue,
} from "~/lib/meeting-language";
import {
  formatDuration,
  formatTranscriptTimestamp,
  getMeetingFailurePresentation,
  getMeetingStatusPresentation,
  isTerminalMeetingStatus,
  type MeetingDetail,
  type MeetingStatusTone,
  type MeetingSummary,
  type TranscriptSegment,
} from "~/lib/meetings-list";
import {
  applySpeakerMap,
  createSpeakerMap,
  formatSpeakerDisplayOwner,
  type SpeakerMap,
} from "~/lib/speaker-display";
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
  const [summaryRegenerationNotice, setSummaryRegenerationNotice] =
    useState<SummaryRegenerationNotice | null>(null);
  const [summaryRegenerationActionError, setSummaryRegenerationActionError] =
    useState<string | null>(null);
  const previousSummaryRegenerationStatusRef = useRef<
    SummaryRegenerationStatus | undefined
  >(meeting.summaryRegenerationStatus);
  const { revalidate } = useRevalidator();
  const submittingIntent = navigation.formData?.get("_intent");
  const isDeleting =
    navigation.state !== "idle" && submittingIntent === "delete-meeting";
  const isUpdatingTitle =
    navigation.state !== "idle" && submittingIntent === "update-title";
  const isRetrying =
    navigation.state !== "idle" && submittingIntent === "retry-meeting";
  const isUpdatingLanguage =
    navigation.state !== "idle" && submittingIntent === "update-language";
  const isRegenerateSubmitting =
    navigation.state !== "idle" && submittingIntent === "regenerate-summary";

  useEffect(() => {
    if (
      !shouldPollMeetingDetail(
        meeting.status,
        meeting.summaryRegenerationStatus,
      )
    ) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void revalidate();
    }, 5_000);

    return () => window.clearInterval(intervalId);
  }, [meeting.status, meeting.summaryRegenerationStatus, revalidate]);

  useEffect(() => {
    if (isActiveSummaryRegeneration(meeting.summaryRegenerationStatus)) {
      previousSummaryRegenerationStatusRef.current =
        meeting.summaryRegenerationStatus;
      setSummaryRegenerationNotice(null);
      setSummaryRegenerationActionError(null);
      return;
    }

    const notice = getObservedSummaryRegenerationNotice(
      previousSummaryRegenerationStatusRef.current,
      meeting.summaryRegenerationStatus,
    );

    previousSummaryRegenerationStatusRef.current =
      meeting.summaryRegenerationStatus;

    if (notice === null) {
      return;
    }

    setSummaryRegenerationActionError(null);
    setSummaryRegenerationNotice(notice);
  }, [meeting.summaryRegenerationStatus]);

  useEffect(() => {
    if (isRegenerateSubmitting) {
      setSummaryRegenerationNotice(null);
      setSummaryRegenerationActionError(null);
    }
  }, [isRegenerateSubmitting]);

  useEffect(() => {
    if (actionData?.intent !== "regenerate-summary") {
      return;
    }

    if (actionData.ok) {
      setSummaryRegenerationActionError(null);
      return;
    }

    setSummaryRegenerationActionError(actionData.error);
  }, [actionData]);

  useEffect(() => {
    if (summaryRegenerationNotice === null) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSummaryRegenerationNotice(null);
    }, 8_000);

    return () => window.clearTimeout(timeoutId);
  }, [summaryRegenerationNotice]);

  const formattedDuration =
    meeting.durationSeconds === null
      ? "Not available"
      : formatDuration(meeting.durationSeconds);
  const titleFeedbackId = "meeting-title-feedback";
  const uploadedLabel = formatMeetingDate(meeting.createdAt);
  const speakerStats = getSpeakerStats(transcriptSegments);

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
            <MetaSeparator />
            <MeetingLanguageMeta
              actionData={actionData}
              isUpdatingLanguage={isUpdatingLanguage}
              meeting={meeting}
            />
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
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                <StatusBadge
                  progress={meeting.transcriptionProgress}
                  status={meeting.status}
                />
                <MeetingExportMenu meetingId={meeting.id} />
              </div>
            </div>
          )}
        </header>
      </div>

      <div className="px-4 pt-8 pb-6 sm:px-6 lg:px-10 lg:pb-10">
        <div className="mx-auto grid w-full max-w-[1500px] gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-6">
            <SummaryPanel
              isRegenerateSubmitting={isRegenerateSubmitting}
              regenerationActionError={summaryRegenerationActionError}
              regenerationNotice={summaryRegenerationNotice}
              regenerationStatus={meeting.summaryRegenerationStatus}
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

          <aside className="space-y-6">
            <ProcessingPanel
              actionData={actionData}
              failedAtStage={meeting.failedAtStage}
              isRetrying={isRetrying}
              meeting={meeting}
              progress={meeting.transcriptionProgress}
              status={meeting.status}
            />
            <div className="xl:sticky xl:top-6">
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
            </div>
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

function MeetingLanguageMeta({
  actionData,
  isUpdatingLanguage,
  meeting,
}: {
  actionData: MeetingActionData | undefined;
  isUpdatingLanguage: boolean;
  meeting: MeetingDetail;
}) {
  const feedback =
    actionData?.intent === "update-language" ? actionData : undefined;
  const feedbackId = "meeting-language-feedback";

  if (meeting.status !== "pending") {
    return (
      <span aria-label={`Language ${formatMeetingLanguageLabel(meeting)}`}>
        {formatMeetingLanguageLabel(meeting)}
      </span>
    );
  }

  return (
    <Form
      aria-label="Transcription language"
      className="flex flex-wrap items-center gap-2"
      method="post"
      preventScrollReset
    >
      <input name="_intent" type="hidden" value="update-language" />
      <label className="sr-only" htmlFor="meeting-language">
        Transcription language
      </label>
      <span aria-hidden="true">Transcription language</span>
      <select
        aria-describedby={feedbackId}
        className="border-hairline bg-surface-elevated text-ink focus:border-brand rounded-lg border px-2 py-1 text-xs transition outline-none disabled:cursor-wait disabled:opacity-70"
        defaultValue={languageToFormValue(meeting.language)}
        disabled={isUpdatingLanguage}
        id="meeting-language"
        name="language"
      >
        <MeetingLanguageOptions />
      </select>
      <button
        className="border-hairline text-ink-soft hover:bg-surface-sunken inline-flex h-7 items-center justify-center rounded-md border px-2 text-xs font-medium transition disabled:cursor-wait disabled:opacity-60"
        disabled={isUpdatingLanguage}
        type="submit"
      >
        {isUpdatingLanguage ? "Saving…" : "Save language"}
      </button>
      <LanguageFeedback actionData={feedback} feedbackId={feedbackId} />
    </Form>
  );
}

function LanguageFeedback({
  actionData,
  feedbackId,
}: {
  actionData: MeetingActionData | undefined;
  feedbackId: string;
}) {
  if (actionData === undefined) {
    return <span className="sr-only" id={feedbackId} />;
  }

  if (!actionData.ok) {
    return (
      <span className="text-danger text-xs font-medium" id={feedbackId}>
        {actionData.error}
      </span>
    );
  }

  return (
    <span className="text-success text-xs font-medium" id={feedbackId}>
      Language saved.
    </span>
  );
}

function MeetingLanguageOptions() {
  return (
    <>
      <option value="sr">Serbian</option>
      <option value="en">English</option>
      <option value="auto">Auto-detect</option>
    </>
  );
}

function MetaSeparator() {
  return (
    <span aria-hidden="true" className="text-ink-subtle/70 select-none">
      ·
    </span>
  );
}

type MeetingExportCopyState = "idle" | "copying" | "copied" | "failed";

const exportFlavors: Array<{
  flavor: MeetingExportFlavor;
  label: string;
  downloadLabel: string;
}> = [
  { downloadLabel: "Summary .md", flavor: "summary", label: "summary" },
  { downloadLabel: "Full .md", flavor: "full", label: "full" },
];

function MeetingExportMenu({ meetingId }: { meetingId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = "meeting-export-popover";
  const onSuccessfulExport = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }

      setIsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        aria-controls={popoverId}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label="Open export options"
        className="bg-brand text-canvas hover:bg-brand-deep inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium shadow-[0_10px_24px_-8px_rgba(63,90,48,0.45)] transition active:translate-y-px"
        onClick={() => setIsOpen((currentIsOpen) => !currentIsOpen)}
        ref={triggerRef}
        type="button"
      >
        <Icon className="size-4" name="download" />
        Export
      </button>
      {isOpen ? (
        <div
          aria-label="Export options"
          className="absolute top-full right-0 z-20 mt-2 w-[min(340px,calc(100vw-2rem))]"
          id={popoverId}
          role="dialog"
        >
          <MeetingExportsPanel
            meetingId={meetingId}
            onExported={onSuccessfulExport}
          />
        </div>
      ) : null}
    </div>
  );
}

export function MeetingExportsPanel({
  meetingId,
  onExported,
}: {
  meetingId: string;
  onExported?: () => void;
}) {
  const [copyStates, setCopyStates] = useState<
    Record<MeetingExportFlavor, MeetingExportCopyState>
  >({ full: "idle", summary: "idle" });

  const setCopyState = (
    flavor: MeetingExportFlavor,
    state: MeetingExportCopyState,
  ) => {
    setCopyStates((currentCopyStates) => ({
      ...currentCopyStates,
      [flavor]: state,
    }));
  };

  const exportPath = (flavor: MeetingExportFlavor) =>
    `/meetings/${meetingId}/exports/${flavor}`;

  const copyMarkdown = async (flavor: MeetingExportFlavor) => {
    setCopyState(flavor, "copying");

    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        throw new Error("Clipboard API is unavailable.");
      }

      const response = await fetch(exportPath(flavor));

      if (!response.ok) {
        throw new Error("Export request failed.");
      }

      await navigator.clipboard.writeText(await response.text());
      setCopyState(flavor, "copied");
      onExported?.();
    } catch {
      setCopyState(flavor, "failed");
    }
  };

  return (
    <aside className={railCardClass} id="export">
      <header>
        <h2 className="font-display text-ink text-lg font-medium tracking-tight">
          Export
        </h2>
        <p className="text-ink-muted mt-1 text-xs leading-5">
          Copy or download Markdown generated from the saved meeting data.
        </p>
      </header>
      <div className="mt-5 space-y-4">
        {exportFlavors.map(({ downloadLabel, flavor, label }) => {
          const copyState = copyStates[flavor];
          const feedbackId = `meeting-export-${flavor}-feedback`;

          return (
            <div className="space-y-2" key={flavor}>
              <div className="grid grid-cols-2 gap-2">
                <button
                  aria-describedby={feedbackId}
                  className="border-hairline text-ink-soft hover:bg-surface-sunken inline-flex h-10 items-center justify-center rounded-lg border px-3 text-sm font-medium transition disabled:cursor-wait disabled:opacity-60"
                  disabled={copyState === "copying"}
                  onClick={() => void copyMarkdown(flavor)}
                  type="button"
                >
                  {getCopyButtonLabel(copyState, label)}
                </button>
                <a
                  className="bg-brand text-canvas hover:bg-brand-deep inline-flex h-10 items-center justify-center rounded-lg px-3 text-sm font-medium shadow-[0_10px_24px_-8px_rgba(63,90,48,0.35)] transition active:translate-y-px"
                  href={`${exportPath(flavor)}?download=1`}
                  onClick={onExported}
                >
                  {downloadLabel}
                </a>
              </div>
              <p
                className={`text-xs ${
                  copyState === "failed" ? "text-danger" : "text-ink-muted"
                }`}
                id={feedbackId}
              >
                {getCopyFeedback(copyState, label)}
              </p>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function getCopyButtonLabel(
  state: MeetingExportCopyState,
  label: string,
): string {
  if (state === "copying") return "Copying…";
  if (state === "copied") return "Copied";
  if (state === "failed") return "Copy failed";
  return `Copy ${label}`;
}

function getCopyFeedback(state: MeetingExportCopyState, label: string): string {
  if (state === "copied") {
    return `${capitalize(label)} Markdown copied to clipboard.`;
  }

  if (state === "failed") {
    return `Could not copy ${label} Markdown. Try downloading instead.`;
  }

  return `${capitalize(label)} export uses saved summary and speaker mappings.`;
}

function isActiveSummaryRegeneration(status: SummaryRegenerationStatus) {
  return status === "pending" || status === "processing";
}

type SummaryRegenerationNotice = {
  message: string;
  tone: "danger" | "success";
};

export function shouldPollMeetingDetail(
  meetingStatus: MeetingStatus,
  regenerationStatus: SummaryRegenerationStatus,
) {
  return (
    !isTerminalMeetingStatus(meetingStatus) ||
    isActiveSummaryRegeneration(regenerationStatus)
  );
}

export function getObservedSummaryRegenerationNotice(
  previousStatus: SummaryRegenerationStatus | undefined,
  currentStatus: SummaryRegenerationStatus,
): SummaryRegenerationNotice | null {
  if (!previousStatus || !isActiveSummaryRegeneration(previousStatus)) {
    return null;
  }

  if (currentStatus === "idle") {
    return { message: "Summary regenerated.", tone: "success" };
  }

  if (currentStatus === "failed") {
    return {
      message:
        "Could not regenerate summary. The previous summary is unchanged.",
      tone: "danger",
    };
  }

  return null;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function SummaryPanel({
  isRegenerateSubmitting = false,
  regenerationActionError,
  regenerationNotice,
  regenerationStatus = "idle",
  speakerMap = {},
  summary,
  status,
}: {
  isRegenerateSubmitting?: boolean;
  regenerationActionError?: string | null;
  regenerationNotice?: SummaryRegenerationNotice | null;
  regenerationStatus?: SummaryRegenerationStatus;
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
  const canRegenerate = status === "done" && summary !== null;
  const isRegenerating =
    isRegenerateSubmitting || isActiveSummaryRegeneration(regenerationStatus);
  const regenerationFeedback =
    regenerationNotice ??
    (regenerationActionError
      ? { message: regenerationActionError, tone: "danger" as const }
      : null);

  return (
    <article aria-labelledby="summary-panel-heading" className="space-y-5">
      <header className="flex flex-wrap items-center gap-3">
        <h2
          className="font-display text-ink text-2xl font-medium tracking-tight"
          id="summary-panel-heading"
        >
          Summary
        </h2>
        <span
          aria-hidden="true"
          className="bg-hairline hidden h-px flex-1 sm:block"
        />
        {canRegenerate ? (
          <Form
            method="post"
            onSubmit={(event) => {
              if (
                !window.confirm(
                  "Regenerate this summary? The current summary will be replaced if regeneration succeeds.",
                )
              ) {
                event.preventDefault();
              }
            }}
            preventScrollReset
          >
            <input name="_intent" type="hidden" value="regenerate-summary" />
            <button
              className="border-hairline text-ink-soft hover:bg-surface-sunken inline-flex h-9 items-center justify-center rounded-lg border px-3 text-sm font-medium transition disabled:cursor-wait disabled:opacity-60"
              disabled={isRegenerating}
              type="submit"
            >
              {isRegenerating ? "Regenerating…" : "Regenerate summary"}
            </button>
          </Form>
        ) : (
          <span className="text-ink-muted font-mono text-[11px] tracking-[0.06em] uppercase">
            Auto-generated
          </span>
        )}
      </header>

      {regenerationFeedback ? (
        <p
          aria-live="polite"
          className={`text-sm font-medium ${
            regenerationFeedback.tone === "danger"
              ? "text-danger"
              : "text-success"
          }`}
        >
          {regenerationFeedback.message}
        </p>
      ) : null}

      {summary === null ? (
        <div className={`${cardClass} scroll-mt-6`} id="overview">
          <EmptyState>{emptyMessage}</EmptyState>
        </div>
      ) : (
        <div className="space-y-5">
          <SummaryGlance
            counts={{
              topics: keyTopics.length,
              decisions: summary.decisions.length,
              actions: summary.actionItems.length,
              questions: summary.openQuestions.length,
            }}
          />

          <SummaryOverview speakerMap={speakerMap} text={summary.overview} />

          <SummarySection
            emptyText="No key topics recorded."
            items={keyTopics}
            renderItem={(topic) => (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p className="text-ink-soft min-w-0 flex-1 text-[15px] leading-6">
                  {topic.label}
                </p>
                {topic.timestamp ? (
                  <time className="text-ink-muted shrink-0 font-mono text-[11px] tabular-nums">
                    {topic.timestamp}
                  </time>
                ) : null}
              </div>
            )}
            sectionId="topics"
          />
          <SummarySection
            emptyText="No action items recorded."
            items={summary.actionItems}
            renderItem={(item) => (
              <div>
                <p className="text-ink-soft text-[15px] leading-6">
                  {applySpeakerMap(item.task, speakerMap)}
                </p>
                <p className="text-ink-muted mt-1.5 font-mono text-[10px] tracking-[0.14em] uppercase">
                  Owner: {formatSpeakerDisplayOwner(item.owner, speakerMap)}
                </p>
              </div>
            )}
            sectionId="actions"
          />
          <SummarySection
            emptyText="No decisions recorded."
            items={summary.decisions}
            renderItem={(decision) => (
              <p className="text-ink-soft text-[15px] leading-6">
                {applySpeakerMap(decision.text, speakerMap)}
              </p>
            )}
            sectionId="decisions"
          />
          <SummarySection
            emptyText="No open questions recorded."
            items={summary.openQuestions}
            renderItem={(question) => (
              <p className="text-ink-soft text-[15px] leading-6">
                {applySpeakerMap(question.text, speakerMap)}
              </p>
            )}
            sectionId="questions"
          />
        </div>
      )}
    </article>
  );
}

type SummarySectionId = "topics" | "actions" | "decisions" | "questions";

const SUMMARY_SECTION_META: Record<
  SummarySectionId,
  {
    anchor: string;
    chipClass: string;
    indexClass: string;
    label: string;
    ruleClass: string;
    shortLabel: string;
  }
> = {
  topics: {
    anchor: "summary-key-topics",
    chipClass:
      "border-hairline text-ink hover:border-ink hover:bg-surface-elevated",
    indexClass: "text-ink-muted",
    label: "Key topics",
    ruleClass: "bg-ink",
    shortLabel: "Topics",
  },
  decisions: {
    anchor: "summary-decisions",
    chipClass:
      "border-brand/25 text-brand-deeper hover:border-brand hover:bg-brand-soft/60",
    indexClass: "text-brand-deep",
    label: "Decisions",
    ruleClass: "bg-brand",
    shortLabel: "Decisions",
  },
  actions: {
    anchor: "summary-action-items",
    chipClass:
      "border-accent/25 text-accent-deep hover:border-accent hover:bg-accent-soft/60",
    indexClass: "text-accent-deep",
    label: "Action items",
    ruleClass: "bg-accent",
    shortLabel: "Actions",
  },
  questions: {
    anchor: "summary-open-questions",
    chipClass:
      "border-warning/30 text-warning hover:border-warning hover:bg-warning-soft/70",
    indexClass: "text-warning",
    label: "Open questions",
    ruleClass: "bg-warning",
    shortLabel: "Questions",
  },
};

const SUMMARY_GLANCE_ORDER: SummarySectionId[] = [
  "topics",
  "decisions",
  "actions",
  "questions",
];

function SummaryGlance({
  counts,
}: {
  counts: Record<SummarySectionId, number>;
}) {
  const total = SUMMARY_GLANCE_ORDER.reduce((sum, id) => sum + counts[id], 0);

  if (total === 0) {
    return null;
  }

  return (
    <nav
      aria-label="Jump to summary section"
      className="border-hairline bg-surface-sunken/40 rounded-xl border p-1.5"
    >
      <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {SUMMARY_GLANCE_ORDER.map((id) => {
          const meta = SUMMARY_SECTION_META[id];
          const count = counts[id];
          const isEmpty = count === 0;

          return (
            <li key={id}>
              <a
                aria-disabled={isEmpty || undefined}
                aria-label={`Jump to ${meta.label} (${count})`}
                className={`group bg-surface focus-visible:ring-ink focus-visible:ring-offset-canvas relative flex h-full flex-col items-start justify-between gap-3 rounded-lg border px-3.5 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                  isEmpty
                    ? "text-ink-subtle pointer-events-none border-transparent opacity-50"
                    : meta.chipClass
                }`}
                href={isEmpty ? undefined : `#${meta.anchor}`}
                onClick={(event) => {
                  if (isEmpty) {
                    event.preventDefault();
                  }
                }}
              >
                <span className="font-display text-3xl leading-none font-medium tracking-tight tabular-nums sm:text-[2rem]">
                  {count}
                </span>
                <span className="flex w-full items-baseline justify-between gap-2">
                  <span className="font-mono text-[10px] tracking-[0.16em] uppercase">
                    {meta.shortLabel}
                  </span>
                  {isEmpty ? null : (
                    <Icon
                      className="size-3 shrink-0 -translate-y-px opacity-40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:opacity-100"
                      name="chevron-right"
                    />
                  )}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function SummaryOverview({
  speakerMap,
  text,
}: {
  speakerMap: SpeakerMap;
  text: string;
}) {
  const mappedText = applySpeakerMap(text, speakerMap).trim();

  if (mappedText.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="summary-overview-heading"
      className={`${cardClass} scroll-mt-6`}
      id="overview"
    >
      <header className="flex items-center gap-3">
        <h3
          className="text-ink-muted font-mono text-[11px] font-medium tracking-[0.16em] uppercase"
          id="summary-overview-heading"
        >
          Overview
        </h3>
        <span aria-hidden="true" className="bg-hairline h-px flex-1" />
      </header>
      <p className="text-ink-soft mt-5 text-[15px] leading-[1.75] whitespace-pre-line">
        {mappedText}
      </p>
    </section>
  );
}

function SummarySection<T>({
  emptyText,
  items,
  renderItem,
  sectionId,
}: {
  emptyText: string;
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  sectionId: SummarySectionId;
}) {
  const meta = SUMMARY_SECTION_META[sectionId];
  const [isExpanded, setIsExpanded] = useState(true);
  const isEmpty = items.length === 0;
  const headingId = `${meta.anchor}-heading`;
  const listId = `${meta.anchor}-list`;

  return (
    <section
      aria-labelledby={headingId}
      className={`${cardClass} scroll-mt-6`}
      id={meta.anchor}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          aria-hidden="true"
          className={`block h-4 w-1 rounded-full ${meta.ruleClass}`}
        />
        <h3
          className="text-ink font-mono text-[11px] font-medium tracking-[0.16em] uppercase"
          id={headingId}
        >
          {meta.label}
        </h3>
        <span className="text-ink-muted font-mono text-[11px] tabular-nums">
          {items.length}
        </span>
        <span aria-hidden="true" className="bg-hairline h-px flex-1" />
        {isEmpty ? null : (
          <button
            aria-controls={listId}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded ? `Hide ${meta.label}` : `Show ${meta.label}`
            }
            className="border-hairline text-ink-muted hover:border-ink hover:text-ink inline-flex size-7 items-center justify-center rounded-full border bg-transparent transition"
            onClick={() => setIsExpanded((previous) => !previous)}
            type="button"
          >
            <Icon
              className={`size-3 transition-transform duration-200 ${
                isExpanded ? "rotate-180" : ""
              }`}
              name="chevron-down"
            />
          </button>
        )}
      </header>

      {isEmpty ? (
        <p className="text-ink-muted mt-5 text-sm leading-6">{emptyText}</p>
      ) : isExpanded ? (
        <ol className="mt-5 space-y-3.5" id={listId}>
          {items.map((item, index) => (
            <li
              className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-x-3 sm:grid-cols-[2rem_minmax(0,1fr)]"
              key={`${meta.anchor}-${index}`}
            >
              <span
                aria-hidden="true"
                className={`pt-[3px] font-mono text-[11px] tracking-[0.04em] tabular-nums ${meta.indexClass}`}
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">{renderItem(item, index)}</div>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
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
                <SpeakerAvatar
                  label={segment.speakerLabel}
                  name={speakerName}
                />
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

export function ProcessingPanel({
  actionData,
  failedAtStage,
  isRetrying = false,
  meeting,
  progress,
  status,
}: {
  actionData?: MeetingActionData;
  failedAtStage: MeetingStatus | null;
  isRetrying?: boolean;
  meeting?: MeetingDetail;
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

  const failurePresentation = meeting
    ? getMeetingFailurePresentation(meeting)
    : null;
  const retryError =
    actionData?.ok === false && actionData.intent === "retry-meeting"
      ? actionData.error
      : null;

  return (
    <aside className={railCardClass} id="processing">
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
        ) : status === "error" ? (
          <span className="text-danger font-mono text-[11px] tracking-[0.06em] uppercase">
            Halted
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
      {failurePresentation?.isRetryable && meeting ? (
        <Form
          className="border-hairline mt-5 border-t pt-5"
          method="post"
          preventScrollReset
        >
          <input name="_intent" type="hidden" value="retry-meeting" />
          <div className="mb-3 space-y-1.5">
            <label
              className="text-ink-muted font-mono text-[11px] tracking-[0.06em] uppercase"
              htmlFor="retry-language"
            >
              Retry language
            </label>
            <select
              className="border-hairline bg-surface-elevated text-ink focus:border-brand w-full rounded-lg border px-3 py-2 text-sm transition outline-none disabled:cursor-wait disabled:opacity-70"
              defaultValue={languageToFormValue(meeting.language)}
              disabled={isRetrying}
              id="retry-language"
              name="language"
            >
              <MeetingLanguageOptions />
            </select>
          </div>
          <button
            className="border-warning/30 bg-warning-soft/60 hover:bg-warning-soft hover:border-warning/50 focus-visible:outline-warning inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium text-[#7a5a16] transition hover:text-[#5e4410] focus-visible:outline-2 focus-visible:outline-offset-2 active:translate-y-px disabled:cursor-wait disabled:opacity-60"
            disabled={isRetrying}
            type="submit"
          >
            <Icon className="size-4" name="refresh" />
            {isRetrying
              ? "Queueing retry…"
              : (failurePresentation.retryLabel ?? "Retry")}
          </button>
          {retryError ? (
            <p className="text-danger mt-3 text-xs leading-snug">
              {retryError}
            </p>
          ) : null}
        </Form>
      ) : null}
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
    <aside className={railCardClass} id="speakers">
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
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
        setIsEditing(false);
      }
    }
  }, [feedback, onNamePersist, onNameUnprotect, speaker.label]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const beginEdit = () => {
    onNameChange(speaker.label, persistedName);
    setIsEditing(true);
  };

  const trimmedPersistedName = persistedName.trim();
  const headingLabel = trimmedPersistedName || speaker.label;

  return (
    <li className="space-y-2 text-sm">
      <fetcher.Form method="post" preventScrollReset>
        <input name="_intent" type="hidden" value="save-speaker-mapping" />
        <input name="speakerLabel" type="hidden" value={speaker.label} />
        <div
          className={`grid grid-cols-[auto_minmax(0,1fr)] gap-3 ${
            isEditing ? "items-start" : "items-center"
          }`}
        >
          <SpeakerAvatar
            label={speaker.label}
            name={trimmedPersistedName || value}
          />
          <div className="min-w-0 space-y-2">
            <div className="group flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <label
                  className="text-ink min-w-0 truncate font-medium"
                  htmlFor={`speaker-mapping-${speaker.label}`}
                >
                  {headingLabel}
                </label>
                {!isEditing ? (
                  <button
                    aria-label={`Edit name for ${speaker.label}`}
                    className="text-ink-subtle hover:bg-surface-sunken hover:text-ink-soft focus-visible:bg-surface-sunken focus-visible:text-ink-soft inline-flex size-6 shrink-0 items-center justify-center rounded-md opacity-40 transition group-focus-within:opacity-100 group-hover:opacity-100"
                    onClick={beginEdit}
                    type="button"
                  >
                    <Icon className="size-3.5" name="pencil" />
                  </button>
                ) : null}
              </div>
              <span className="text-ink-muted shrink-0 font-mono text-xs tabular-nums">
                {speaker.percentage}% ·{" "}
                {durationSeconds === null
                  ? "—"
                  : formatDuration(Math.max(0, speaker.durationSeconds))}
              </span>
            </div>
            {isEditing ? (
              <>
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
                      setIsEditing(false);
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
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onNameChange(speaker.label, persistedName);
                      onNameUnprotect(speaker.label);
                      setIsEditing(false);
                    }
                  }}
                  placeholder="Add name"
                  ref={inputRef}
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
              </>
            ) : error ? (
              <p className="text-danger text-xs" id={feedbackId}>
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </fetcher.Form>
    </li>
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

export function ErrorBlock({ meeting }: { meeting: MeetingDetail }) {
  const presentation = getMeetingFailurePresentation(meeting);
  const title = presentation?.title ?? "Processing failed";

  return (
    <details
      className="group border-danger/25 bg-surface [&[open]]:bg-surface-elevated rounded-xl border"
      data-testid="meeting-failure-disclosure"
    >
      <summary className="hover:bg-danger-soft/30 flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 transition select-none [&::-webkit-details-marker]:hidden">
        <span className="bg-danger-soft text-danger inline-flex size-6 shrink-0 items-center justify-center rounded-full">
          <Icon className="size-3.5" name="alert" />
        </span>
        <span className="text-ink min-w-0 flex-1 text-sm font-medium">
          <span className="text-danger">{title}</span>
          <span className="text-ink-muted ml-2 hidden text-xs font-normal sm:inline">
            · pipeline halted
          </span>
        </span>
        <span className="text-ink-muted font-mono text-[10px] tracking-[0.08em] uppercase group-open:hidden">
          Details
        </span>
        <span className="text-ink-muted hidden font-mono text-[10px] tracking-[0.08em] uppercase group-open:inline">
          Hide
        </span>
        <Icon
          className="text-ink-muted size-4 shrink-0 transition-transform duration-200 group-open:rotate-180"
          name="chevron-down"
        />
      </summary>
      <div className="border-danger/15 border-t px-4 py-4 sm:px-5 sm:py-5">
        {presentation?.message ? (
          <p className="text-ink-soft text-sm leading-6">
            {presentation.message}
          </p>
        ) : null}
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 sm:gap-4">
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
            <dd className="border-hairline bg-canvas text-ink-soft mt-2 rounded-lg border p-3 font-mono text-xs leading-relaxed">
              {meeting.errorMessage ?? "No error message was recorded."}
            </dd>
          </div>
        </dl>
      </div>
    </details>
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

function SpeakerAvatar({ label, name }: { label: string; name?: string }) {
  const trimmedName = name?.trim();
  const initial = trimmedName
    ? trimmedName.charAt(0).toUpperCase()
    : formatSpeakerLabel(label).charAt(0).toUpperCase() || "S";
  const colorIndex = getSpeakerColorIndex(label);

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
  "bg-[#e3dde9] text-[#5e4a73]",
  "bg-warning-soft text-warning",
  "bg-[#dbdfe6] text-[#3b4860]",
  "bg-accent-soft text-accent-deep",
  "bg-[#cfe1de] text-[#2f5a52]",
  "bg-danger-soft text-danger",
  "bg-[#f0d6dc] text-[#7a3a48]",
] as const;

function getSpeakerColorIndex(label: string) {
  const speakerMatch = /^SPEAKER[_ -]?(\d+)$/i.exec(label.trim());

  if (speakerMatch) {
    return Number(speakerMatch[1]) % speakerAvatarClasses.length;
  }

  return Math.abs(hashString(label)) % speakerAvatarClasses.length;
}

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
