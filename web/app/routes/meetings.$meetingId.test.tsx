import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { MeetingStatus, SummaryRegenerationStatus } from "~/db/schema";
import type {
  MeetingDetail,
  MeetingSummary,
  TranscriptSegment,
} from "~/lib/meetings-list";
import type { SpeakerMap } from "~/lib/speaker-display";
import MeetingDetailPage, {
  ErrorBlock,
  getObservedSummaryRegenerationNotice,
  MeetingExportsPanel,
  ProcessingPanel,
  shouldPollMeetingDetail,
  SummaryPanel,
  TranscriptPanel,
} from "./meetings.$meetingId";

function renderTranscriptPanel({
  segments,
  speakerMap = {},
  status,
}: {
  segments: TranscriptSegment[];
  speakerMap?: SpeakerMap;
  status: MeetingStatus;
}) {
  return renderToStaticMarkup(
    <TranscriptPanel
      segments={segments}
      speakerMap={speakerMap}
      status={status}
    />,
  );
}

function renderSummaryPanel({
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
  regenerationNotice?: Parameters<typeof SummaryPanel>[0]["regenerationNotice"];
  regenerationStatus?: SummaryRegenerationStatus;
  speakerMap?: SpeakerMap;
  summary: MeetingSummary | null;
  status: MeetingStatus;
}) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <SummaryPanel
            isRegenerateSubmitting={isRegenerateSubmitting}
            regenerationActionError={regenerationActionError}
            regenerationNotice={regenerationNotice}
            regenerationStatus={regenerationStatus}
            speakerMap={speakerMap}
            summary={summary}
            status={status}
          />
        ),
      },
    ],
    { initialEntries: ["/"] },
  );

  return renderToStaticMarkup(<RouterProvider router={router} />);
}

function renderMeetingExportsPanel(
  meetingId = "00000000-0000-4000-8000-000000000123",
) {
  return renderToStaticMarkup(<MeetingExportsPanel meetingId={meetingId} />);
}

function renderMeetingDetailPage({
  meetingOverrides = {},
  summary = null,
}: {
  meetingOverrides?: Partial<MeetingDetail>;
  summary?: MeetingSummary | null;
} = {}) {
  const routeMeeting = meeting({
    status: "done",
    errorKind: null,
    errorMessage: null,
    failedAtStage: null,
    transcriptionProgress: null,
    ...meetingOverrides,
  });
  const routeProps = {
    loaderData: {
      meeting: routeMeeting,
      speakerMappings: [],
      summary,
      transcriptSegments: [],
    },
  } as unknown as Parameters<typeof MeetingDetailPage>[0];
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <MeetingDetailPage {...routeProps} />,
      },
    ],
    { initialEntries: ["/"] },
  );

  return renderToStaticMarkup(<RouterProvider router={router} />);
}

function renderProcessingPanel({
  actionData,
  failedAtStage = null,
  isRetrying = false,
  meetingForFailure,
  progress = null,
  status,
}: {
  actionData?: Parameters<typeof ProcessingPanel>[0]["actionData"];
  failedAtStage?: MeetingStatus | null;
  isRetrying?: boolean;
  meetingForFailure?: MeetingDetail;
  progress?: number | null;
  status: MeetingStatus;
}) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <ProcessingPanel
            actionData={actionData}
            failedAtStage={failedAtStage}
            isRetrying={isRetrying}
            meeting={meetingForFailure}
            progress={progress}
            status={status}
          />
        ),
      },
    ],
    { initialEntries: ["/"] },
  );

  return renderToStaticMarkup(<RouterProvider router={router} />);
}

function meeting(overrides: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    id: "00000000-0000-4000-8000-000000000123",
    title: "Retry Test",
    status: "error",
    transcriptionProgress: null,
    durationSeconds: 300,
    language: "sr",
    detectedLanguage: null,
    errorKind: "diarization_failed",
    errorMessage: "speaker clustering failed",
    failedAtStage: "diarizing",
    createdAt: "2026-05-05T10:00:00.000Z",
    updatedAt: "2026-05-05T10:05:00.000Z",
    summaryRegenerationStatus: "idle",
    summaryRegenerationProcessingStartedAt: null,
    ...overrides,
  };
}

function renderErrorBlock(props: Parameters<typeof ErrorBlock>[0]) {
  const router = createMemoryRouter(
    [{ path: "/", element: <ErrorBlock {...props} /> }],
    { initialEntries: ["/"] },
  );

  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("MeetingExportsPanel", () => {
  test("renders copy controls and server-backed markdown download links", () => {
    const markup = renderMeetingExportsPanel();

    expect(markup).toContain("Copy summary");
    expect(markup).toContain("Copy full");
    expect(markup).toContain(
      'href="/meetings/00000000-0000-4000-8000-000000000123/exports/summary?download=1"',
    );
    expect(markup).toContain(
      'href="/meetings/00000000-0000-4000-8000-000000000123/exports/full?download=1"',
    );
  });

  test("keeps copy client-side and downloads as server links", () => {
    const source = readFileSync(
      new URL("./meetings.$meetingId.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("fetch(exportPath(flavor))");
    expect(source).toContain("navigator.clipboard.writeText");
    expect(source).toContain("?download=1");
    expect(source).not.toContain("new Blob");
    expect(source).not.toContain('value="copy-summary"');
    expect(source).not.toContain('value="copy-full"');
  });
});

describe("ErrorBlock", () => {
  test("renders as a collapsed disclosure summarizing the failure title", () => {
    const markup = renderErrorBlock({ meeting: meeting() });

    expect(markup).toContain("<details");
    expect(markup).toContain("<summary");
    expect(markup).toContain('data-testid="meeting-failure-disclosure"');
    expect(markup).not.toContain(" open");
    expect(markup).toContain("Speaker identification failed");
  });

  test("never renders a retry control inside the failure disclosure", () => {
    const markup = renderErrorBlock({ meeting: meeting() });

    expect(markup).not.toContain('value="retry-meeting"');
    expect(markup).not.toContain("Retry from");
    expect(markup).not.toContain("Queueing retry");
  });

  test("keeps diagnostic detail markup available behind the disclosure", () => {
    const markup = renderErrorBlock({
      meeting: meeting({
        errorKind: "summarization_failed",
        errorMessage: "OpenRouter summary response was not valid JSON",
        failedAtStage: "summarizing",
      }),
    });

    expect(markup).toContain("Error kind");
    expect(markup).toContain("summarization_failed");
    expect(markup).toContain("Failed at stage");
    expect(markup).toContain("summarizing");
    expect(markup).toContain("Error message");
    expect(markup).toContain("OpenRouter summary response was not valid JSON");
  });

  test("renders the disclosure for non-retryable failures too", () => {
    for (const nonRetryableMeeting of [
      meeting({
        errorKind: "transcription_empty",
        errorMessage: "No speech detected.",
        failedAtStage: "transcribing",
      }),
      meeting({
        errorKind: "config_missing",
        errorMessage: "OPENROUTER_API_KEY is missing.",
        failedAtStage: "summarizing",
      }),
      meeting({
        errorKind: "normalization_failed",
        errorMessage: "invalid data found while processing input",
        failedAtStage: "normalizing",
      }),
    ]) {
      const markup = renderErrorBlock({ meeting: nonRetryableMeeting });

      expect(markup).toContain("<details");
      expect(markup).not.toContain('value="retry-meeting"');
      expect(markup).not.toContain("Retry from");
    }
  });
});

describe("meeting detail language controls", () => {
  test("shows the resolved language label in the detail header", () => {
    const markup = renderMeetingDetailPage({
      meetingOverrides: { language: null, detectedLanguage: "sr" },
    });

    expect(markup).toContain("Auto-detected Serbian");
  });

  test("renders inline language editor only while pending", () => {
    const pendingMarkup = renderMeetingDetailPage({
      meetingOverrides: { status: "pending", language: "sr" },
    });
    const doneMarkup = renderMeetingDetailPage({
      meetingOverrides: { status: "done", language: "sr" },
    });

    expect(pendingMarkup).toContain('value="update-language"');
    expect(pendingMarkup).toContain('name="language"');
    expect(pendingMarkup).toContain("Transcription language");
    expect(pendingMarkup).toContain("Save language");
    expect(doneMarkup).not.toContain('value="update-language"');
    expect(doneMarkup).toContain("Serbian");
  });
});

describe("ProcessingPanel retry affordance", () => {
  test("renders inline retry beside the failed stage for retryable failures", () => {
    const failureMeeting = meeting();
    const markup = renderProcessingPanel({
      failedAtStage: failureMeeting.failedAtStage,
      meetingForFailure: failureMeeting,
      progress: failureMeeting.transcriptionProgress,
      status: failureMeeting.status,
    });

    expect(markup).toContain('value="retry-meeting"');
    expect(markup).toContain("Retry from speaker identification");
    expect(markup).toContain("Halted");
  });

  test("renders a retry language picker defaulting to the failed meeting language", () => {
    const failureMeeting = meeting({ language: null, detectedLanguage: "sr" });
    const markup = renderProcessingPanel({
      failedAtStage: failureMeeting.failedAtStage,
      meetingForFailure: failureMeeting,
      progress: failureMeeting.transcriptionProgress,
      status: failureMeeting.status,
    });

    expect(markup).toContain("Retry language");
    expect(markup).toContain('name="language"');
    expect(markup).toContain('value="sr"');
    expect(markup).toContain('value="en"');
    expect(markup).toContain('value="auto"');
    expect(markup).toContain("Auto-detect");
  });

  test("shows queueing label while a retry is submitting", () => {
    const failureMeeting = meeting();
    const markup = renderProcessingPanel({
      failedAtStage: failureMeeting.failedAtStage,
      isRetrying: true,
      meetingForFailure: failureMeeting,
      progress: failureMeeting.transcriptionProgress,
      status: failureMeeting.status,
    });

    expect(markup).toContain("Queueing retry…");
  });

  test("hides inline retry when no failure meeting is supplied", () => {
    const markup = renderProcessingPanel({ status: "transcribing" });

    expect(markup).not.toContain('value="retry-meeting"');
  });

  test("hides inline retry for non-retryable failure kinds", () => {
    for (const nonRetryableMeeting of [
      meeting({
        errorKind: "transcription_empty",
        errorMessage: "No speech detected.",
        failedAtStage: "transcribing",
      }),
      meeting({
        errorKind: "config_missing",
        errorMessage: "OPENROUTER_API_KEY is missing.",
        failedAtStage: "summarizing",
      }),
      meeting({
        errorKind: "normalization_failed",
        errorMessage: "invalid data found while processing input",
        failedAtStage: "normalizing",
      }),
    ]) {
      const markup = renderProcessingPanel({
        failedAtStage: nonRetryableMeeting.failedAtStage,
        meetingForFailure: nonRetryableMeeting,
        progress: nonRetryableMeeting.transcriptionProgress,
        status: nonRetryableMeeting.status,
      });

      expect(markup).not.toContain('value="retry-meeting"');
      expect(markup).not.toContain("Retry from");
    }
  });

  test("renders retry validation feedback under the failed stage", () => {
    const failureMeeting = meeting();
    const markup = renderProcessingPanel({
      actionData: {
        ok: false,
        intent: "retry-meeting",
        error: "This failure cannot be retried.",
      },
      failedAtStage: failureMeeting.failedAtStage,
      meetingForFailure: failureMeeting,
      progress: failureMeeting.transcriptionProgress,
      status: failureMeeting.status,
    });

    expect(markup).toContain("This failure cannot be retried.");
  });
});

const savedSummary: MeetingSummary = {
  overview: "Team aligned on release readiness.",
  decisions: [{ text: "Ship on Friday." }],
  actionItems: [
    {
      task: "Publish release notes",
      owner: { kind: "name", value: "Atila" },
    },
  ],
  openQuestions: [{ text: "Should we include optional migration docs?" }],
  updatedAt: "2026-05-07T20:00:00.000Z",
};

describe("meeting detail export control", () => {
  test("renders export as a compact header action instead of a right-rail card", () => {
    const markup = renderMeetingDetailPage();

    expect(markup).toContain("Export");
    expect(markup).toContain('aria-label="Open export options"');
    expect(markup).toContain('aria-haspopup="dialog"');
    // Export trigger should not include a chevron-down indicator in its rendered SVG.
    const exportTriggerMatch = markup.match(
      /<button[^>]*aria-label="Open export options"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(exportTriggerMatch).not.toBeNull();
    expect(exportTriggerMatch?.[0] ?? "").not.toContain("m6 9 6 6 6-6");
    expect(markup).not.toContain('id="export"');
    expect(markup).not.toContain(
      "Copy or download Markdown generated from the saved meeting data.",
    );
  });

  test("keeps header export enabled regardless of processing status or summary presence", () => {
    const processingMarkup = renderMeetingDetailPage({
      meetingOverrides: { status: "summarizing" },
      summary: null,
    });

    expect(processingMarkup).toContain('aria-label="Open export options"');
    expect(processingMarkup).not.toContain('disabled=""');
    expect(processingMarkup).not.toContain(
      'title="Export is available after processing finishes"',
    );

    const doneWithoutSummaryMarkup = renderMeetingDetailPage({ summary: null });

    expect(doneWithoutSummaryMarkup).toContain(
      'aria-label="Open export options"',
    );
    expect(doneWithoutSummaryMarkup).not.toContain('disabled=""');
    expect(doneWithoutSummaryMarkup).not.toContain(
      'title="Export is available after processing finishes"',
    );
  });

  test("closes the export dropdown on successful export, outside click, and Escape", () => {
    const source = readFileSync(
      new URL("./meetings.$meetingId.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('document.addEventListener("pointerdown"');
    expect(source).toContain('document.addEventListener("keydown"');
    expect(source).toContain('event.key !== "Escape"');
    expect(source).toContain("triggerRef.current?.focus()");
    expect(source).toContain("onSuccessfulExport");
    expect(source).toContain("onExported?.()");
    expect(source).toContain("onExported={onSuccessfulExport}");
    expect(source).toContain("onClick={onExported}");
  });
});

describe("summary regeneration observed notices", () => {
  test("reports success only after active regeneration returns to idle", () => {
    expect(getObservedSummaryRegenerationNotice("pending", "idle")).toEqual({
      message: "Summary regenerated.",
      tone: "success",
    });
    expect(getObservedSummaryRegenerationNotice("processing", "idle")).toEqual({
      message: "Summary regenerated.",
      tone: "success",
    });
  });

  test("reports failure only after active regeneration transitions to failed", () => {
    expect(getObservedSummaryRegenerationNotice("pending", "failed")).toEqual({
      message:
        "Could not regenerate summary. The previous summary is unchanged.",
      tone: "danger",
    });
    expect(
      getObservedSummaryRegenerationNotice("processing", "failed"),
    ).toEqual({
      message:
        "Could not regenerate summary. The previous summary is unchanged.",
      tone: "danger",
    });
  });

  test("does not show stale failed feedback on initial or non-active observations", () => {
    expect(
      getObservedSummaryRegenerationNotice(undefined, "failed"),
    ).toBeNull();
    expect(getObservedSummaryRegenerationNotice("failed", "failed")).toBeNull();
    expect(getObservedSummaryRegenerationNotice("idle", "failed")).toBeNull();
  });
});

describe("SummaryPanel", () => {
  test("shows regenerate action only for done meetings with a summary", () => {
    const doneWithSummaryMarkup = renderSummaryPanel({
      status: "done",
      summary: savedSummary,
    });

    expect(doneWithSummaryMarkup).toContain("Regenerate summary");
    expect(doneWithSummaryMarkup).toContain('value="regenerate-summary"');

    expect(
      renderSummaryPanel({ status: "summarizing", summary: savedSummary }),
    ).not.toContain("Regenerate summary");
    expect(renderSummaryPanel({ status: "done", summary: null })).not.toContain(
      "Regenerate summary",
    );
  });

  test("confirms regeneration with exact replacement warning", () => {
    const source = readFileSync(
      new URL("./meetings.$meetingId.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "Regenerate this summary? The current summary will be replaced if regeneration succeeds.",
    );
  });

  test("disables regenerate action while regeneration is active or submitting", () => {
    for (const regenerationStatus of ["pending", "processing"] as const) {
      const markup = renderSummaryPanel({
        regenerationStatus,
        status: "done",
        summary: savedSummary,
      });

      expect(markup).toContain("Regenerating…");
      expect(markup).toContain('disabled=""');
      expect(markup).toContain("Team aligned on release readiness.");
    }

    const submittingMarkup = renderSummaryPanel({
      isRegenerateSubmitting: true,
      status: "done",
      summary: savedSummary,
    });

    expect(submittingMarkup).toContain("Regenerating…");
    expect(submittingMarkup).toContain('disabled=""');
    expect(submittingMarkup).toContain("Team aligned on release readiness.");
  });

  test("polls the detail route every five seconds while summary regeneration is active", () => {
    expect(shouldPollMeetingDetail("done", "pending")).toBe(true);
    expect(shouldPollMeetingDetail("done", "processing")).toBe(true);
    expect(shouldPollMeetingDetail("done", "idle")).toBe(false);
    expect(shouldPollMeetingDetail("done", "failed")).toBe(false);
    expect(shouldPollMeetingDetail("summarizing", "idle")).toBe(true);

    const source = readFileSync(
      new URL("./meetings.$meetingId.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("shouldPollMeetingDetail(");
    expect(source).toContain("window.setInterval");
    expect(source).toContain("5_000");
  });

  test("keeps the processing panel in its completed state for done meetings", () => {
    const markup = renderProcessingPanel({ status: "done" });

    expect(markup).toContain("Processing");
    expect(markup).toContain("Normalize audio");
    expect(markup).toContain("Transcribe");
    expect(markup).toContain("Identify speakers");
    expect(markup).toContain("Summarize");
    expect(markup).not.toContain("Queued");
    expect(markup).not.toContain("Generating transcript");
    expect(markup).not.toContain("Extracting key moments");
  });

  test("renders regeneration notices without replacing the saved summary", () => {
    const successMarkup = renderSummaryPanel({
      regenerationNotice: { message: "Summary regenerated.", tone: "success" },
      status: "done",
      summary: savedSummary,
    });

    expect(successMarkup).toContain("Summary regenerated.");
    expect(successMarkup).toContain("Team aligned on release readiness.");

    const failureMarkup = renderSummaryPanel({
      regenerationNotice: {
        message:
          "Could not regenerate summary. The previous summary is unchanged.",
        tone: "danger",
      },
      status: "done",
      summary: savedSummary,
    });

    expect(failureMarkup).toContain(
      "Could not regenerate summary. The previous summary is unchanged.",
    );
    expect(failureMarkup).toContain("Team aligned on release readiness.");
  });

  test("renders regenerate action errors from action data", () => {
    const markup = renderSummaryPanel({
      regenerationActionError: "A regeneration is already queued.",
      status: "done",
      summary: savedSummary,
    });

    expect(markup).toContain("A regeneration is already queued.");
    expect(markup).toContain("Team aligned on release readiness.");
  });

  test("renders overview, decisions, action items, and open questions read-only", () => {
    const markup = renderSummaryPanel({
      status: "done",
      summary: {
        overview: "Team aligned on release readiness.",
        decisions: [{ text: "Ship on Friday." }],
        actionItems: [
          {
            task: "Publish release notes",
            owner: { kind: "name", value: "Atila" },
          },
          {
            task: "Notify stakeholders",
            owner: { kind: "speaker", value: "SPEAKER_01" },
          },
          { task: "Document follow-up", owner: { kind: "unknown" } },
        ],
        openQuestions: [{ text: "Should we include optional migration docs?" }],
        updatedAt: "2026-05-07T20:00:00.000Z",
      },
    });

    expect(markup).toContain("Summary");
    expect(markup).toContain("Overview");
    expect(markup).toContain("Team aligned on release readiness.");
    expect(markup).toContain("Decisions");
    expect(markup).toContain("Ship on Friday.");
    expect(markup).toContain("Action items");
    expect(markup).toContain("Owner: Atila");
    expect(markup).toContain("Owner: SPEAKER_01");
    expect(markup).toContain("Owner: Unassigned");
    expect(markup).toContain("Open questions");
    expect(markup).toContain("Should we include optional migration docs?");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("contenteditable");
  });

  test("applies speaker mappings to rendered summary prose and speaker owners", () => {
    const markup = renderSummaryPanel({
      speakerMap: { SPEAKER_00: "Atila", SPEAKER_01: "Marko" },
      status: "done",
      summary: {
        overview: "SPEAKER_00 aligned with SPEAKER_01.",
        decisions: [{ text: "SPEAKER_01 owns rollout." }],
        actionItems: [
          {
            task: "SPEAKER_00 will publish notes.",
            owner: { kind: "speaker", value: "SPEAKER_00" },
          },
          {
            task: "SPEAKER_02 remains unmapped.",
            owner: { kind: "speaker", value: "SPEAKER_02" },
          },
        ],
        openQuestions: [{ text: "Should SPEAKER_01 invite design?" }],
        updatedAt: "2026-05-07T20:00:00.000Z",
      },
    });

    expect(markup).toContain("Atila aligned with Marko.");
    expect(markup).toContain("Marko owns rollout.");
    expect(markup).toContain("Atila will publish notes.");
    expect(markup).toContain("Owner: Atila");
    expect(markup).toContain("SPEAKER_02 remains unmapped.");
    expect(markup).toContain("Owner: SPEAKER_02");
    expect(markup).toContain("Should Marko invite design?");
  });

  test("renders status-aware empty state copy", () => {
    expect(
      renderSummaryPanel({ summary: null, status: "summarizing" }),
    ).toContain("Summary will appear here after summarization finishes.");
    expect(renderSummaryPanel({ summary: null, status: "error" })).toContain(
      "No summary was saved before processing failed.",
    );
    expect(renderSummaryPanel({ summary: null, status: "done" })).toContain(
      "Summary is not available for this meeting.",
    );
  });
});

describe("Speakers panel markup contract", () => {
  test("keeps blur-save intent hidden fields, no visible per-row save button, and textbox row rendering in source", () => {
    const source = readFileSync(
      new URL("./meetings.$meetingId.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'name="_intent" type="hidden" value="save-speaker-mapping"',
    );
    expect(source).toContain(
      'name="speakerLabel" type="hidden" value={speaker.label}',
    );
    expect(source).toContain("id={`speaker-mapping-${speaker.label}`}");
    expect(source).toContain('type="text"');
    expect(source).not.toContain("Save</button>");
  });
});

describe("TranscriptPanel", () => {
  test("renders timestamped transcript rows as read-only content", () => {
    const markup = renderTranscriptPanel({
      status: "done",
      segments: [
        {
          id: "00000000-0000-4000-8000-00000000a111",
          startSeconds: 0,
          endSeconds: 2,
          speakerLabel: "SPEAKER_00",
          text: "Kickoff.",
        },
        {
          id: "00000000-0000-4000-8000-00000000a112",
          startSeconds: 75.9,
          endSeconds: 78,
          speakerLabel: "SPEAKER_01",
          text: "Next step.",
        },
      ],
    });

    expect(markup).toContain("Transcript");
    expect(markup).toContain("[0:00]");
    expect(markup).toContain("[1:15]");
    expect(markup).toContain("SPEAKER_00");
    expect(markup).toContain("SPEAKER_01");
    expect(markup).toContain("Next step.");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("contenteditable");
  });

  test("applies speaker mappings to transcript display names", () => {
    const markup = renderTranscriptPanel({
      speakerMap: { SPEAKER_00: "Atila" },
      status: "done",
      segments: [
        {
          id: "00000000-0000-4000-8000-00000000a114",
          startSeconds: 0,
          endSeconds: 2,
          speakerLabel: "SPEAKER_00",
          text: "Mapped row.",
        },
        {
          id: "00000000-0000-4000-8000-00000000a115",
          startSeconds: 3,
          endSeconds: 5,
          speakerLabel: "SPEAKER_01",
          text: "Unmapped row.",
        },
      ],
    });

    expect(markup).toContain("Atila");
    expect(markup).toContain("SPEAKER_01");
    expect(markup).not.toContain("Speaker 1");
  });

  test("keeps transcript rows visible while diarizing", () => {
    const markup = renderTranscriptPanel({
      status: "diarizing",
      segments: [
        {
          id: "00000000-0000-4000-8000-00000000a113",
          startSeconds: 12,
          endSeconds: 16,
          speakerLabel: "SPEAKER_01",
          text: "Diarization can continue while rows remain visible.",
        },
      ],
    });

    expect(markup).toContain("SPEAKER_01");
    expect(markup).toContain(
      "Diarization can continue while rows remain visible.",
    );
    expect(markup).not.toContain("Transcript will appear here");
    expect(markup).not.toContain("Map speaker");
    expect(markup).not.toContain("speaker mapping");
    expect(markup).not.toContain("<select");
  });

  test("renders status-aware empty state copy", () => {
    expect(
      renderTranscriptPanel({ segments: [], status: "transcribing" }),
    ).toContain("Transcript will appear here when transcription finishes.");
    expect(renderTranscriptPanel({ segments: [], status: "error" })).toContain(
      "No transcript was saved before processing failed.",
    );
    expect(renderTranscriptPanel({ segments: [], status: "done" })).toContain(
      "Transcript is not available for this meeting.",
    );
  });
});
