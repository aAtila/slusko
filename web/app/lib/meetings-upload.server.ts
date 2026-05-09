import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import busboy from "busboy";
import {
  defaultMeetingLanguage,
  parseMeetingLanguageFormValue,
  type MeetingLanguage,
} from "./meeting-language";
import {
  getMeetingsStorageRoot,
  removeMeetingDirectory,
} from "./meeting-storage.server";

const oneMb = 1024 * 1024;
const defaultMaxUploadMb = 1024;
const allowedRecordingExtensions = new Set([".mp3", ".m4a", ".wav", ".mp4"]);

export type PendingMeetingUpload = {
  id: string;
  sourceFilename: string;
  title: string;
  uploadedBy: string;
  language: MeetingLanguage;
};

type CreatePendingMeetingUploadOptions = {
  enqueuePendingMeeting?: (meeting: PendingMeetingUpload) => Promise<void>;
  generateMeetingId?: () => string;
  maxUploadBytes?: number;
  meetingsStorageRoot?: string;
  uploadedBy?: string;
};

type StoredRecordingUpload = {
  id: string;
  originalPath: string;
  sourceFilename: string;
  title: string;
  language: MeetingLanguage;
};

export class MeetingUploadError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "MeetingUploadError";
    this.status = status;
  }
}

export function isMeetingUploadError(
  error: unknown,
): error is MeetingUploadError {
  return error instanceof MeetingUploadError;
}

export async function createPendingMeetingFromUpload(
  request: Request,
  options: CreatePendingMeetingUploadOptions = {},
) {
  const meetingId = options.generateMeetingId?.() ?? crypto.randomUUID();
  const meetingsStorageRoot =
    options.meetingsStorageRoot ?? getMeetingsStorageRoot();
  const uploadedBy = options.uploadedBy ?? getUploadedBy();
  const maxUploadBytes = options.maxUploadBytes ?? getMaxUploadBytes();
  let storedUpload: StoredRecordingUpload | null = null;

  try {
    storedUpload = await streamSingleRecordingToDisk(request, {
      maxUploadBytes,
      meetingId,
      meetingsStorageRoot,
    });

    const pendingMeeting = {
      id: storedUpload.id,
      sourceFilename: storedUpload.sourceFilename,
      title: storedUpload.title,
      uploadedBy,
      language: storedUpload.language,
    } satisfies PendingMeetingUpload;

    await (options.enqueuePendingMeeting ?? insertAndNotifyPendingMeeting)(
      pendingMeeting,
    );

    return pendingMeeting;
  } catch (error) {
    const normalizedError = normalizeUploadError(error, maxUploadBytes);

    try {
      await removeMeetingDirectory({ meetingId, meetingsStorageRoot });
    } catch {
      // Preserve the primary upload failure for the user; cleanup is best-effort.
    }

    throw normalizedError;
  }
}

async function streamSingleRecordingToDisk(
  request: Request,
  {
    maxUploadBytes,
    meetingId,
    meetingsStorageRoot,
  }: {
    maxUploadBytes: number;
    meetingId: string;
    meetingsStorageRoot: string;
  },
): Promise<StoredRecordingUpload> {
  if (!request.body) {
    throw new MeetingUploadError("Choose one recording file to upload.");
  }

  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw new MeetingUploadError(
      "Upload one recording file as multipart form data.",
    );
  }

  let parser: ReturnType<typeof busboy>;

  try {
    parser = busboy({
      headers: { "content-type": contentType },
      limits: {
        fields: 1,
        fileSize: maxUploadBytes,
        files: 1,
      },
    });
  } catch {
    throw new MeetingUploadError(
      "Upload one recording file as multipart form data.",
    );
  }

  return new Promise((resolve, reject) => {
    const fileWrites: Promise<void>[] = [];
    let fileSeen = false;
    let storedUpload: Omit<StoredRecordingUpload, "language"> | null = null;
    let language: MeetingLanguage | undefined;
    let languageSeen = false;
    let settled = false;
    let uploadError: Error | null = null;

    const fail = (error: Error) => {
      uploadError ??= error;
    };

    parser.on("file", (fieldName, file, info) => {
      fileSeen = true;

      if (fieldName !== "recording") {
        fail(
          new MeetingUploadError(
            "Upload one recording file using the recording field.",
          ),
        );
        file.resume();
        return;
      }

      const sourceFilename = safeSourceFilename(info.filename);
      if (!sourceFilename) {
        fail(new MeetingUploadError("Choose one recording file to upload."));
        file.resume();
        return;
      }

      const extension = path.extname(sourceFilename).toLowerCase();
      if (!allowedRecordingExtensions.has(extension)) {
        fail(
          new MeetingUploadError(
            "Unsupported recording type. Upload an .mp3, .m4a, .wav, or .mp4 file.",
          ),
        );
        file.resume();
        return;
      }

      const meetingDir = path.join(meetingsStorageRoot, meetingId);
      const originalPath = path.join(meetingDir, `original${extension}`);
      const partialPath = `${originalPath}.partial`;

      storedUpload = {
        id: meetingId,
        originalPath,
        sourceFilename,
        title: titleFromFilename(sourceFilename),
      };

      const write = (async () => {
        await mkdir(meetingDir, { recursive: true });
        await pipeline(file, createWriteStream(partialPath, { flags: "wx" }));

        if (file.truncated) {
          throw new MeetingUploadError(maxUploadMessage(maxUploadBytes), 413);
        }

        await rename(partialPath, originalPath);
      })();

      fileWrites.push(write);
    });

    parser.on("field", (fieldName, value) => {
      if (fieldName !== "language") {
        fail(
          new MeetingUploadError(
            "Upload one recording file with only the optional language field.",
          ),
        );
        return;
      }

      if (languageSeen) {
        fail(new MeetingUploadError("Choose one meeting language."));
        return;
      }

      languageSeen = true;
      const parsedLanguage = parseMeetingLanguageFormValue(value);

      if (!parsedLanguage.ok) {
        fail(new MeetingUploadError(parsedLanguage.error));
        return;
      }

      language = parsedLanguage.language;
    });

    parser.on("fieldsLimit", () => {
      fail(new MeetingUploadError("Choose one meeting language."));
    });

    parser.on("filesLimit", () => {
      fail(new MeetingUploadError("Upload one recording file at a time."));
    });

    parser.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    parser.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;

      Promise.all(fileWrites)
        .then(() => {
          if (uploadError) {
            reject(uploadError);
            return;
          }

          if (!fileSeen || storedUpload === null) {
            reject(
              new MeetingUploadError("Choose one recording file to upload."),
            );
            return;
          }

          resolve({
            ...storedUpload,
            language:
              language === undefined ? defaultMeetingLanguage : language,
          });
        })
        .catch(reject);
    });

    const abortUpload = () => {
      fail(
        new MeetingUploadError(
          "Upload was cancelled before it completed.",
          499,
        ),
      );
      parser.destroy(uploadError ?? undefined);
    };

    request.signal.addEventListener("abort", abortUpload, { once: true });

    const requestStream = Readable.fromWeb(
      request.body as unknown as NodeReadableStream<Uint8Array>,
    );

    requestStream.on("error", (error) => {
      fail(error);
      parser.destroy(error);
    });

    requestStream.pipe(parser);
  });
}

async function insertAndNotifyPendingMeeting(meeting: PendingMeetingUpload) {
  const { sqlClient } = await import("~/db/client.server");

  await sqlClient.begin(async (sql) => {
    await sql`
      insert into meetings (id, title, source_filenames, uploaded_by, language, status)
      values (
        ${meeting.id},
        ${meeting.title},
        ${sql.array([meeting.sourceFilename], 25)},
        ${meeting.uploadedBy},
        ${meeting.language},
        'pending'
      )
    `;

    await sql`select pg_notify('meetings_pending', ${meeting.id})`;
  });
}

function normalizeUploadError(error: unknown, maxUploadBytes: number) {
  if (isMeetingUploadError(error)) {
    return error;
  }

  if (error instanceof Error && error.message.includes("File size limit")) {
    return new MeetingUploadError(maxUploadMessage(maxUploadBytes), 413);
  }

  return error;
}

function getMaxUploadBytes() {
  const configuredMb = Number(process.env.MAX_UPLOAD_MB ?? defaultMaxUploadMb);

  if (!Number.isFinite(configuredMb) || configuredMb <= 0) {
    return defaultMaxUploadMb * oneMb;
  }

  return Math.floor(configuredMb * oneMb);
}

function getUploadedBy() {
  return process.env.SLUSKO_UPLOADED_BY ?? process.env.USER ?? "local-user";
}

function maxUploadMessage(maxUploadBytes: number) {
  return `Recording is too large. Upload a file up to ${Math.floor(
    maxUploadBytes / oneMb,
  )} MB.`;
}

function safeSourceFilename(filename: string | undefined) {
  const normalized = (filename ?? "").split(/[\\/]/).at(-1)?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function titleFromFilename(filename: string) {
  const extension = path.extname(filename);
  const withoutExtension = filename
    .slice(0, filename.length - extension.length)
    .trim();
  return withoutExtension.length > 0 ? withoutExtension : "Untitled meeting";
}
