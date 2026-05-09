import { describe, expect, test } from "bun:test";
import {
  loadMeetingDetail,
  loadMeetingDetailRouteData,
  type MeetingDetailRow,
  type SummaryRow,
  type TranscriptSegmentRow,
} from "./meetings-list.server";

const meetingId = "00000000-0000-4000-8000-000000000007";

function detailRow(
  overrides: Partial<MeetingDetailRow> = {},
): MeetingDetailRow {
  return {
    id: meetingId,
    title: "Issue 7 Sync",
    status: "error",
    transcriptionProgress: null,
    durationSeconds: 125,
    language: "sr",
    detectedLanguage: null,
    errorKind: "normalization_failed",
    errorMessage: "ffmpeg could not read original.m4a",
    failedAtStage: "normalizing",
    createdAt: new Date("2026-05-05T10:00:00.000Z"),
    updatedAt: new Date("2026-05-05T10:02:00.000Z"),
    summaryRegenerationStatus: "idle",
    summaryRegenerationProcessingStartedAt: null,
    ...overrides,
  };
}

function summaryRow(overrides: Partial<SummaryRow> = {}): SummaryRow {
  return {
    overview: "Discussed launch readiness and blocker follow-ups.",
    decisions: [{ text: "Proceed with staged rollout." }],
    actionItems: [
      {
        task: "Prepare release notes",
        owner: { kind: "name", value: "Atila" },
      },
    ],
    openQuestions: [
      { text: "Do we include beta metrics in the public changelog?" },
    ],
    updatedAt: new Date("2026-05-05T10:03:00.000Z"),
    ...overrides,
  };
}

function transcriptSegmentRow(
  overrides: Partial<TranscriptSegmentRow> = {},
): TranscriptSegmentRow {
  return {
    id: "00000000-0000-4000-8000-00000000a001",
    startSeconds: 12.4,
    endSeconds: 15.9,
    speakerLabel: "SPEAKER_00",
    text: "Ship it.",
    ...overrides,
  };
}

describe("meeting detail loader helpers", () => {
  test("returns the selected meeting status, duration, and failure fields", async () => {
    const meeting = await loadMeetingDetail(meetingId, {
      findMeetingById: async (id) => (id === meetingId ? detailRow() : null),
    });

    expect(meeting).toEqual({
      id: meetingId,
      title: "Issue 7 Sync",
      status: "error",
      transcriptionProgress: null,
      durationSeconds: 125,
      language: "sr",
      detectedLanguage: null,
      errorKind: "normalization_failed",
      errorMessage: "ffmpeg could not read original.m4a",
      failedAtStage: "normalizing",
      createdAt: "2026-05-05T10:00:00.000Z",
      updatedAt: "2026-05-05T10:02:00.000Z",
      summaryRegenerationStatus: "idle",
      summaryRegenerationProcessingStartedAt: null,
    });
  });

  test("serializes meeting language fields", async () => {
    const meeting = await loadMeetingDetail(meetingId, {
      findMeetingById: async (id) =>
        id === meetingId
          ? detailRow({ language: null, detectedLanguage: "hr" })
          : null,
    });

    expect(meeting).toMatchObject({
      language: null,
      detectedLanguage: "hr",
    });
  });

  test("serializes active summary regeneration processing state", async () => {
    const meeting = await loadMeetingDetail(meetingId, {
      findMeetingById: async (id) =>
        id === meetingId
          ? detailRow({
              status: "done",
              summaryRegenerationStatus: "processing",
              summaryRegenerationProcessingStartedAt: new Date(
                "2026-05-05T10:04:00.000Z",
              ),
            })
          : null,
    });

    expect(meeting).toMatchObject({
      status: "done",
      summaryRegenerationStatus: "processing",
      summaryRegenerationProcessingStartedAt: "2026-05-05T10:04:00.000Z",
    });
  });

  test("returns null for an unknown meeting", async () => {
    await expect(
      loadMeetingDetail("missing", {
        findMeetingById: async () => null,
      }),
    ).resolves.toBeNull();
  });

  test("route data helper throws a 404 response for an invalid meeting id", async () => {
    let finderWasCalled = false;

    const error = await captureThrownResponse(
      loadMeetingDetailRouteData("not-a-uuid", {
        findMeetingById: async () => {
          finderWasCalled = true;
          return null;
        },
      }),
    );

    expect(error.status).toBe(404);
    expect(finderWasCalled).toBe(false);
  });

  test("route data helper includes per-meeting speaker mappings", async () => {
    const mappingCalls: string[] = [];

    const routeData = await loadMeetingDetailRouteData(meetingId, {
      findMeetingById: async (id) => (id === meetingId ? detailRow() : null),
      findSummaryByMeetingId: async () => null,
      findTranscriptSegmentsByMeetingId: async () => [],
      findSpeakerMappingsByMeetingId: async (id) => {
        mappingCalls.push(id);
        return [
          { speakerLabel: "SPEAKER_00", name: "Atila" },
          { speakerLabel: "SPEAKER_01", name: "Marko" },
        ];
      },
    });

    expect(routeData.speakerMappings).toEqual([
      { speakerLabel: "SPEAKER_00", name: "Atila" },
      { speakerLabel: "SPEAKER_01", name: "Marko" },
    ]);
    expect(mappingCalls).toEqual([meetingId]);
  });

  test("route data helper includes transcript segments", async () => {
    const transcriptCalls: string[] = [];

    const routeData = await loadMeetingDetailRouteData(meetingId, {
      findMeetingById: async (id) => (id === meetingId ? detailRow() : null),
      findSummaryByMeetingId: async () => summaryRow(),
      findTranscriptSegmentsByMeetingId: async (id) => {
        transcriptCalls.push(id);
        return [
          transcriptSegmentRow({
            id: "00000000-0000-4000-8000-00000000a002",
            startSeconds: 0,
            endSeconds: 1,
            text: "Intro",
          }),
          transcriptSegmentRow(),
        ];
      },
      findSpeakerMappingsByMeetingId: async () => [],
    });

    expect(routeData.meeting.id).toBe(meetingId);
    expect(routeData.summary).toEqual({
      overview: "Discussed launch readiness and blocker follow-ups.",
      decisions: [{ text: "Proceed with staged rollout." }],
      actionItems: [
        {
          task: "Prepare release notes",
          owner: { kind: "name", value: "Atila" },
        },
      ],
      openQuestions: [
        { text: "Do we include beta metrics in the public changelog?" },
      ],
      updatedAt: "2026-05-05T10:03:00.000Z",
    });
    expect(routeData.transcriptSegments).toEqual([
      {
        id: "00000000-0000-4000-8000-00000000a002",
        startSeconds: 0,
        endSeconds: 1,
        speakerLabel: "SPEAKER_00",
        text: "Intro",
      },
      {
        id: "00000000-0000-4000-8000-00000000a001",
        startSeconds: 12.4,
        endSeconds: 15.9,
        speakerLabel: "SPEAKER_00",
        text: "Ship it.",
      },
    ]);
    expect(transcriptCalls).toEqual([meetingId]);
  });

  test("route data helper returns an empty transcript when no segments exist", async () => {
    const routeData = await loadMeetingDetailRouteData(meetingId, {
      findMeetingById: async () => detailRow(),
      findSummaryByMeetingId: async () => null,
      findTranscriptSegmentsByMeetingId: async () => [],
      findSpeakerMappingsByMeetingId: async () => [],
    });

    expect(routeData.summary).toBeNull();
    expect(routeData.transcriptSegments).toEqual([]);
  });

  test("route data helper throws a 404 response for an unknown meeting", async () => {
    const missingMeetingId = "00000000-0000-4000-8000-000000000404";
    const finderCalls: string[] = [];
    let transcriptFinderWasCalled = false;

    const error = await captureThrownResponse(
      loadMeetingDetailRouteData(missingMeetingId, {
        findMeetingById: async (id) => {
          finderCalls.push(id);
          return null;
        },
        findTranscriptSegmentsByMeetingId: async () => {
          transcriptFinderWasCalled = true;
          return [];
        },
        findSpeakerMappingsByMeetingId: async () => {
          throw new Error(
            "speaker mappings should not be loaded for missing meetings",
          );
        },
      }),
    );

    expect(error.status).toBe(404);
    expect(finderCalls).toEqual([missingMeetingId]);
    expect(transcriptFinderWasCalled).toBe(false);
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
