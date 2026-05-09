import { describe, expect, test } from "bun:test";
import { meetingStatus, summaryRegenerationStatus } from "./schema";
import {
  developmentMeetingSeeds,
  developmentTranscriptSegmentSeeds,
} from "./seed-data";

const allowedSourceExtensions = /\.(mp3|m4a|wav|mp4)$/i;

function meetingIdsWithTranscriptRows() {
  return new Set(
    developmentTranscriptSegmentSeeds.map((segment) => segment.meetingId),
  );
}

describe("development meeting seeds", () => {
  test("defines the bounded summary regeneration lifecycle", () => {
    expect(summaryRegenerationStatus.enumValues).toEqual([
      "idle",
      "pending",
      "processing",
      "failed",
    ]);
  });

  test("cover every canonical meeting status with stable IDs", () => {
    const ids = developmentMeetingSeeds.map((meeting) => meeting.id);
    const statuses = new Set(
      developmentMeetingSeeds.map((meeting) => meeting.status),
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(statuses).toEqual(new Set(meetingStatus.enumValues));
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

    for (const meeting of developmentMeetingSeeds) {
      if (meeting.status !== "transcribing") {
        expect(meeting.transcriptionProgress).toBeNull();
      }
    }
  });

  test("mirror upload source filename constraints and split recordings", () => {
    expect(
      developmentMeetingSeeds.some(
        (meeting) => meeting.sourceFilenames.length > 1,
      ),
    ).toBe(true);

    for (const meeting of developmentMeetingSeeds) {
      for (const sourceFilename of meeting.sourceFilenames) {
        expect(sourceFilename).toMatch(allowedSourceExtensions);
      }
    }
  });

  test("cover polling terminal and non-terminal lifecycle states", () => {
    const statuses = new Set(
      developmentMeetingSeeds.map((meeting) => meeting.status),
    );

    expect(statuses.has("done")).toBe(true);
    expect(statuses.has("error")).toBe(true);
    expect(
      developmentMeetingSeeds.some(
        (meeting) => meeting.status !== "done" && meeting.status !== "error",
      ),
    ).toBe(true);
  });

  test("include transcript rows for lifecycle states that should render them", () => {
    const transcriptMeetingIds = meetingIdsWithTranscriptRows();

    expect(
      developmentMeetingSeeds.some(
        (meeting) =>
          meeting.status === "diarizing" &&
          transcriptMeetingIds.has(meeting.id),
      ),
    ).toBe(true);
    expect(
      developmentMeetingSeeds.some(
        (meeting) =>
          meeting.status === "done" && transcriptMeetingIds.has(meeting.id),
      ),
    ).toBe(true);
    expect(
      developmentMeetingSeeds.some(
        (meeting) =>
          meeting.status === "error" &&
          meeting.failedAtStage === "diarizing" &&
          transcriptMeetingIds.has(meeting.id),
      ),
    ).toBe(true);

    const transcriptionEmptyMeetingIds = new Set(
      developmentMeetingSeeds
        .filter((meeting) => meeting.errorKind === "transcription_empty")
        .map((meeting) => meeting.id),
    );

    expect(transcriptionEmptyMeetingIds.size).toBeGreaterThan(0);
    for (const meetingId of transcriptionEmptyMeetingIds) {
      expect(transcriptMeetingIds.has(meetingId)).toBe(false);
    }
  });

  test("keep transcript fixtures internally consistent", () => {
    const meetingIds = new Set(
      developmentMeetingSeeds.map((meeting) => meeting.id),
    );
    const transcriptIds = developmentTranscriptSegmentSeeds.map(
      (segment) => segment.id,
    );

    expect(new Set(transcriptIds).size).toBe(transcriptIds.length);

    for (const segment of developmentTranscriptSegmentSeeds) {
      expect(meetingIds.has(segment.meetingId)).toBe(true);
      expect(segment.endSeconds).toBeGreaterThan(segment.startSeconds);
    }
  });

  test("include ADR-0007 failure metadata on every error seed", () => {
    const errorSeeds = developmentMeetingSeeds.filter(
      (meeting) => meeting.status === "error",
    );
    const transcriptMeetingIds = meetingIdsWithTranscriptRows();

    expect(errorSeeds.length).toBeGreaterThan(0);
    for (const meeting of errorSeeds) {
      expect(meeting.errorKind).not.toBeNull();
      expect(meeting.errorMessage).not.toBeNull();
      expect(meeting.failedAtStage).not.toBeNull();
      expect(meeting.resumeFromStage).not.toBeNull();
    }

    const transcriptionEmpty = errorSeeds.find(
      (meeting) => meeting.errorKind === "transcription_empty",
    );
    expect(transcriptionEmpty).toBeDefined();
    if (!transcriptionEmpty) {
      throw new Error("Expected a transcription_empty error seed");
    }
    expect(transcriptionEmpty.failedAtStage).toBe("transcribing");
    expect(transcriptionEmpty.resumeFromStage).toBe("transcribing");
    expect(transcriptMeetingIds.has(transcriptionEmpty.id)).toBe(false);

    const diarizationFailure = errorSeeds.find(
      (meeting) => meeting.errorKind === "diarization_failed",
    );
    expect(diarizationFailure).toBeDefined();
    if (!diarizationFailure) {
      throw new Error("Expected a diarization_failed error seed");
    }
    expect(diarizationFailure.failedAtStage).toBe("diarizing");
    expect(diarizationFailure.resumeFromStage).toBe("diarizing");
    expect(transcriptMeetingIds.has(diarizationFailure.id)).toBe(true);
  });
});
