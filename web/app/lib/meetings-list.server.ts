import { desc } from "drizzle-orm";
import { db } from "~/db/client.server";
import { meetings } from "~/db/schema";
import type { HomeMeetingListItem } from "./meetings-list";

export async function loadHomeMeetings(): Promise<HomeMeetingListItem[]> {
  const rows = await db
    .select({
      id: meetings.id,
      title: meetings.title,
      status: meetings.status,
      transcriptionProgress: meetings.transcriptionProgress,
      durationSeconds: meetings.durationSeconds,
      createdAt: meetings.createdAt,
    })
    .from(meetings)
    .orderBy(desc(meetings.createdAt));

  return rows.map((meeting) => ({
    ...meeting,
    createdAt: meeting.createdAt.toISOString(),
  }));
}
