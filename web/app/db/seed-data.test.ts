import { describe, expect, test } from "bun:test";
import { developmentMeetingSeeds } from "./seed-data";

describe("development meeting seeds", () => {
  test("cover useful local meeting states with stable IDs", () => {
    const ids = developmentMeetingSeeds.map((meeting) => meeting.id);
    const statuses = new Set(
      developmentMeetingSeeds.map((meeting) => meeting.status),
    );

    expect(developmentMeetingSeeds.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);
    expect(statuses).toContain("pending");
    expect(statuses).toContain("transcribing");
    expect(statuses).toContain("done");
    expect(statuses).toContain("error");
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
