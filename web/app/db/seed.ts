import { sql } from "drizzle-orm";
import { db, sqlClient } from "./client.server";
import { meetings } from "./schema";
import { developmentMeetingSeeds } from "./seed-data";

export async function seedDevelopmentMeetings({ reset = false } = {}) {
  if (reset) {
    await db.delete(meetings);
  }

  await db
    .insert(meetings)
    .values(developmentMeetingSeeds)
    .onConflictDoUpdate({
      target: meetings.id,
      set: {
        title: sql`excluded.title`,
        sourceFilenames: sql`excluded.source_filenames`,
        uploadedBy: sql`excluded.uploaded_by`,
        status: sql`excluded.status`,
        errorKind: sql`excluded.error_kind`,
        errorMessage: sql`excluded.error_message`,
        failedAtStage: sql`excluded.failed_at_stage`,
        resumeFromStage: sql`excluded.resume_from_stage`,
        transcriptionProgress: sql`excluded.transcription_progress`,
        durationSeconds: sql`excluded.duration_seconds`,
        createdAt: sql`excluded.created_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  return developmentMeetingSeeds.length;
}

if (import.meta.main) {
  const reset = process.argv.includes("--reset");

  try {
    const count = await seedDevelopmentMeetings({ reset });
    console.log(
      reset
        ? `Reset database and seeded ${count} development meetings.`
        : `Seeded ${count} development meetings.`,
    );
  } finally {
    await sqlClient.end();
  }
}
