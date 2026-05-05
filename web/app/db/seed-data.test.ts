import { describe, expect, test } from "bun:test";
import { developmentMeetingSeeds } from "./seed-data";

describe("development meeting seeds", () => {
  test("cover every canonical meeting status with stable IDs", () => {
    const ids = developmentMeetingSeeds.map((meeting) => meeting.id);
    const statuses = new Set(
      developmentMeetingSeeds.map((meeting) => meeting.status),
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(statuses).toEqual(
      new Set([
        "pending",
        "normalizing",
        "transcribing",
        "diarizing",
        "summarizing",
        "done",
        "error",
      ]),
    );
  });

  test("include transcribing examples with and without numeric progress", () => {
    const transcribingSeeds = developmentMeetingSeeds.filter(
      (meeting) => meeting.status === "transcribing",
    );

    expect(
      transcribingSeeds.some(
        (meeting) => meeting.transcriptionProgress !== null,
      ),
    ).toBe(true);
    expect(
      transcribingSeeds.some(
        (meeting) => meeting.transcriptionProgress === null,
      ),
    ).toBe(true);
  });

  test("include examples for split recordings and pipeline failure state", () => {
    expect(
      developmentMeetingSeeds.some(
        (meeting) => meeting.sourceFilenames.length > 1,
      ),
    ).toBe(true);

    expect(
      developmentMeetingSeeds.some(
        (meeting) =>
          meeting.status === "error" &&
          meeting.errorKind !== null &&
          meeting.failedAtStage !== null &&
          meeting.resumeFromStage !== null,
      ),
    ).toBe(true);
  });
});
