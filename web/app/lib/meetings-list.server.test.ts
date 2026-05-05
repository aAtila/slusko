import { describe, expect, test } from "bun:test";
import {
  loadMeetingDetail,
  loadMeetingDetailRouteData,
  type MeetingDetailRow,
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
    errorKind: "normalization_failed",
    errorMessage: "ffmpeg could not read original.m4a",
    failedAtStage: "normalizing",
    createdAt: new Date("2026-05-05T10:00:00.000Z"),
    updatedAt: new Date("2026-05-05T10:02:00.000Z"),
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
      errorKind: "normalization_failed",
      errorMessage: "ffmpeg could not read original.m4a",
      failedAtStage: "normalizing",
      createdAt: "2026-05-05T10:00:00.000Z",
      updatedAt: "2026-05-05T10:02:00.000Z",
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

  test("route data helper throws a 404 response for an unknown meeting", async () => {
    const missingMeetingId = "00000000-0000-4000-8000-000000000404";
    const finderCalls: string[] = [];

    const error = await captureThrownResponse(
      loadMeetingDetailRouteData(missingMeetingId, {
        findMeetingById: async (id) => {
          finderCalls.push(id);
          return null;
        },
      }),
    );

    expect(error.status).toBe(404);
    expect(finderCalls).toEqual([missingMeetingId]);
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
