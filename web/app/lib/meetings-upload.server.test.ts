import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createPendingMeetingFromUpload,
  isMeetingUploadError,
  type PendingMeetingUpload,
} from "./meetings-upload.server";

const meetingId = "00000000-0000-4000-8000-000000000004";

async function tempMeetingsRoot() {
  return mkdtemp(path.join(os.tmpdir(), "slusko-meetings-upload-"));
}

function uploadRequest(
  file: File,
  extraFields?: Record<string, string> | [string, string][],
) {
  const body = new FormData();
  body.append("recording", file);

  const fields = Array.isArray(extraFields)
    ? extraFields
    : Object.entries(extraFields ?? {});

  for (const [name, value] of fields) {
    body.append(name, value);
  }

  return new Request("http://localhost/", {
    body,
    method: "POST",
  });
}

describe("meeting upload", () => {
  test("streams one supported recording to the meeting directory before enqueueing a pending meeting", async () => {
    const meetingsStorageRoot = await tempMeetingsRoot();
    const enqueued: PendingMeetingUpload[] = [];

    const meeting = await createPendingMeetingFromUpload(
      uploadRequest(new File(["audio bytes"], "Weekly Sync.mp3")),
      {
        enqueuePendingMeeting: async (pendingMeeting) => {
          const originalPath = path.join(
            meetingsStorageRoot,
            meetingId,
            "original.mp3",
          );

          expect(await readFile(originalPath, "utf8")).toBe("audio bytes");
          enqueued.push(pendingMeeting);
        },
        generateMeetingId: () => meetingId,
        meetingsStorageRoot,
        uploadedBy: "test-user",
      },
    );

    expect(meeting).toEqual({
      id: meetingId,
      sourceFilename: "Weekly Sync.mp3",
      title: "Weekly Sync",
      uploadedBy: "test-user",
      language: "sr",
    });
    expect(enqueued).toEqual([meeting]);
  });

  test("rejects unsupported recording types without leaving a meeting directory", async () => {
    const meetingsStorageRoot = await tempMeetingsRoot();

    const error = await captureMeetingUploadError(
      createPendingMeetingFromUpload(
        uploadRequest(new File(["not audio"], "notes.txt")),
        {
          enqueuePendingMeeting: async () => {
            throw new Error("unsupported uploads must not enqueue meetings");
          },
          generateMeetingId: () => meetingId,
          meetingsStorageRoot,
        },
      ),
    );

    expect(error.message).toContain("Unsupported recording type");

    await expect(readdir(meetingsStorageRoot)).resolves.toEqual([]);
  });

  test("rejects extra multipart fields outside the single recording contract", async () => {
    const meetingsStorageRoot = await tempMeetingsRoot();

    const error = await captureMeetingUploadError(
      createPendingMeetingFromUpload(
        uploadRequest(new File(["audio bytes"], "recording.m4a"), {
          ignored: "field",
        }),
        {
          enqueuePendingMeeting: async () => {
            throw new Error(
              "uploads with extra fields must not enqueue meetings",
            );
          },
          generateMeetingId: () => meetingId,
          meetingsStorageRoot,
        },
      ),
    );

    expect(error.message).toContain("only the optional language field");
    await expect(readdir(meetingsStorageRoot)).resolves.toEqual([]);
  });

  test("accepts English as the requested meeting language", async () => {
    const meetingsStorageRoot = await tempMeetingsRoot();

    const meeting = await createPendingMeetingFromUpload(
      uploadRequest(new File(["audio bytes"], "client-call.mp3"), {
        language: "en",
      }),
      {
        enqueuePendingMeeting: async () => {},
        generateMeetingId: () => meetingId,
        meetingsStorageRoot,
      },
    );

    expect(meeting.language).toBe("en");
  });

  test("normalizes Auto-detect uploads to a null requested language", async () => {
    const meetingsStorageRoot = await tempMeetingsRoot();

    const meeting = await createPendingMeetingFromUpload(
      uploadRequest(new File(["audio bytes"], "mixed-language.wav"), {
        language: "auto",
      }),
      {
        enqueuePendingMeeting: async () => {},
        generateMeetingId: () => meetingId,
        meetingsStorageRoot,
      },
    );

    expect(meeting.language).toBeNull();
  });

  test("rejects invalid meeting language values", async () => {
    for (const language of ["de", ""] as const) {
      const meetingsStorageRoot = await tempMeetingsRoot();

      const error = await captureMeetingUploadError(
        createPendingMeetingFromUpload(
          uploadRequest(new File(["audio bytes"], "recording.mp3"), {
            language,
          }),
          {
            enqueuePendingMeeting: async () => {
              throw new Error(
                "invalid language uploads must not enqueue meetings",
              );
            },
            generateMeetingId: () => meetingId,
            meetingsStorageRoot,
          },
        ),
      );

      expect(error.message).toBe("Choose Serbian, English, or Auto-detect.");
      await expect(readdir(meetingsStorageRoot)).resolves.toEqual([]);
    }
  });

  test("rejects duplicate meeting language fields", async () => {
    const meetingsStorageRoot = await tempMeetingsRoot();

    const error = await captureMeetingUploadError(
      createPendingMeetingFromUpload(
        uploadRequest(new File(["audio bytes"], "recording.mp3"), [
          ["language", "sr"],
          ["language", "en"],
        ]),
        {
          enqueuePendingMeeting: async () => {
            throw new Error(
              "duplicate language uploads must not enqueue meetings",
            );
          },
          generateMeetingId: () => meetingId,
          meetingsStorageRoot,
        },
      ),
    );

    expect(error.message).toBe("Choose one meeting language.");
    await expect(readdir(meetingsStorageRoot)).resolves.toEqual([]);
  });

  test("removes the stored recording if enqueueing the pending meeting fails", async () => {
    const meetingsStorageRoot = await tempMeetingsRoot();
    const meetingDir = path.join(meetingsStorageRoot, meetingId);

    await expect(
      createPendingMeetingFromUpload(
        uploadRequest(new File(["audio bytes"], "db-failure.mp4")),
        {
          enqueuePendingMeeting: async () => {
            expect(
              await readFile(path.join(meetingDir, "original.mp4"), "utf8"),
            ).toBe("audio bytes");
            throw new Error("database unavailable");
          },
          generateMeetingId: () => meetingId,
          meetingsStorageRoot,
        },
      ),
    ).rejects.toThrow("database unavailable");

    await expect(stat(meetingDir)).rejects.toThrow();
  });

  test("treats malformed multipart uploads as clear client errors", async () => {
    const meetingsStorageRoot = await tempMeetingsRoot();

    const error = await captureMeetingUploadError(
      createPendingMeetingFromUpload(
        new Request("http://localhost/", {
          body: "not a multipart body",
          headers: { "content-type": "multipart/form-data" },
          method: "POST",
        }),
        {
          enqueuePendingMeeting: async () => {
            throw new Error("malformed uploads must not enqueue meetings");
          },
          generateMeetingId: () => meetingId,
          meetingsStorageRoot,
        },
      ),
    );

    expect(error.status).toBe(400);
    expect(error.message).toContain("multipart form data");
    await expect(readdir(meetingsStorageRoot)).resolves.toEqual([]);
  });

  test("rejects oversized recordings and removes partial files", async () => {
    const meetingsStorageRoot = await tempMeetingsRoot();

    const error = await captureMeetingUploadError(
      createPendingMeetingFromUpload(
        uploadRequest(new File(["0123456789"], "too-big.wav")),
        {
          enqueuePendingMeeting: async () => {
            throw new Error("oversized uploads must not enqueue meetings");
          },
          generateMeetingId: () => meetingId,
          maxUploadBytes: 4,
          meetingsStorageRoot,
        },
      ),
    );

    expect(error.status).toBe(413);
    expect(error.message).toContain("too large");

    await expect(
      stat(path.join(meetingsStorageRoot, meetingId)),
    ).rejects.toThrow();
  });
});

async function captureMeetingUploadError(
  promise: Promise<PendingMeetingUpload>,
) {
  try {
    await promise;
  } catch (error) {
    if (!isMeetingUploadError(error)) {
      throw error;
    }

    return error;
  }

  throw new Error("Expected meeting upload to fail");
}
