import { describe, expect, test } from "bun:test";
import type { MeetingDetailRouteData } from "~/lib/meetings-list";
import { createMeetingExportResourceLoader } from "./meetings.$meetingId.exports.$flavor";

const meetingId = "00000000-0000-4000-8000-000000000007";

function buildRouteData(): MeetingDetailRouteData {
  return {
    meeting: {
      id: meetingId,
      title: "Weekly Sync",
      status: "done",
      transcriptionProgress: null,
      durationSeconds: 75,
      language: "sr",
      detectedLanguage: null,
      errorKind: null,
      errorMessage: null,
      failedAtStage: null,
      createdAt: "2026-05-05T10:00:00.000Z",
      updatedAt: "2026-05-05T10:02:00.000Z",
      summaryRegenerationStatus: "idle",
      summaryRegenerationProcessingStartedAt: null,
    },
    summary: {
      overview: "SPEAKER_00 aligned with SPEAKER_01 on priorities.",
      decisions: [{ text: "SPEAKER_01 owns release timing." }],
      actionItems: [
        {
          task: "SPEAKER_00 prepares the rollout note.",
          owner: { kind: "speaker", value: "SPEAKER_00" },
        },
      ],
      openQuestions: [{ text: "Can SPEAKER_02 join QA review?" }],
      updatedAt: "2026-05-05T11:00:00.000Z",
    },
    transcriptSegments: [
      {
        id: "segment-1",
        startSeconds: 0,
        endSeconds: 4,
        speakerLabel: "SPEAKER_00",
        text: "Kickoff complete.",
      },
    ],
    speakerMappings: [
      { speakerLabel: "SPEAKER_00", name: "Atila" },
      { speakerLabel: "SPEAKER_01", name: "Marko" },
    ],
  };
}

describe("meeting export resource route", () => {
  test("returns inline summary markdown with no-store caching", async () => {
    const loader = createMeetingExportResourceLoader({
      loadMeetingDetailRouteData: async () => buildRouteData(),
    });

    const response = await loader({
      params: { meetingId, flavor: "summary" },
      request: new Request("http://localhost/meetings/x/exports/summary"),
    });

    expect(response.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBe(
      'inline; filename="2026-05-05-weekly-sync.md"',
    );

    const body = await response.text();
    expect(body).toContain("# Weekly Sync");
    expect(body).toContain("## Overview");
  });

  test("returns full markdown as attachment when download=1", async () => {
    const loader = createMeetingExportResourceLoader({
      loadMeetingDetailRouteData: async () => buildRouteData(),
    });

    const response = await loader({
      params: { meetingId, flavor: "full" },
      request: new Request(
        "http://localhost/meetings/x/exports/full?download=1",
      ),
    });

    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="2026-05-05-weekly-sync.md"',
    );
    expect(await response.text()).toContain("## Transcript");
  });

  test("exports the current summary while regeneration is active", async () => {
    const data = buildRouteData();
    data.meeting.summaryRegenerationStatus = "processing";
    data.meeting.summaryRegenerationProcessingStartedAt =
      "2026-05-05T11:05:00.000Z";
    const summary = data.summary;
    if (summary === null) {
      throw new Error("Expected test fixture to include a summary");
    }
    data.summary = {
      ...summary,
      overview: "Current summary remains exportable during regeneration.",
    };

    const loader = createMeetingExportResourceLoader({
      loadMeetingDetailRouteData: async () => data,
    });

    const response = await loader({
      params: { meetingId, flavor: "summary" },
      request: new Request("http://localhost/meetings/x/exports/summary"),
    });

    expect(await response.text()).toContain(
      "Current summary remains exportable during regeneration.",
    );
  });

  test("throws 404 for invalid export flavor", async () => {
    let loadWasCalled = false;
    const loader = createMeetingExportResourceLoader({
      loadMeetingDetailRouteData: async () => {
        loadWasCalled = true;
        return buildRouteData();
      },
    });

    const error = await captureThrownResponse(
      loader({
        params: { meetingId, flavor: "plain" },
        request: new Request("http://localhost/meetings/x/exports/plain"),
      }),
    );

    expect(error.status).toBe(404);
    expect(loadWasCalled).toBe(false);
  });

  test("propagates 404 for invalid or unknown meeting IDs", async () => {
    const loader = createMeetingExportResourceLoader({
      loadMeetingDetailRouteData: async () => {
        throw new Response("Meeting not found", { status: 404 });
      },
    });

    const invalidIdError = await captureThrownResponse(
      loader({
        params: { meetingId: "not-a-uuid", flavor: "summary" },
        request: new Request(
          "http://localhost/meetings/not-a-uuid/exports/summary",
        ),
      }),
    );
    expect(invalidIdError.status).toBe(404);

    const unknownIdError = await captureThrownResponse(
      loader({
        params: {
          meetingId: "00000000-0000-4000-8000-000000000404",
          flavor: "full",
        },
        request: new Request(
          "http://localhost/meetings/00000000-0000-4000-8000-000000000404/exports/full",
        ),
      }),
    );
    expect(unknownIdError.status).toBe(404);
  });
});

async function captureThrownResponse(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected a Response to be thrown");
}
