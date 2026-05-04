import type { meetings } from "./schema";

export type DevelopmentMeetingSeed = typeof meetings.$inferInsert;

const seedCreatedAt = new Date("2026-05-04T09:00:00.000Z");
const seedUpdatedAt = new Date("2026-05-04T09:00:00.000Z");

export const developmentMeetingSeeds = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Weekly product sync",
    sourceFilenames: ["weekly-product-sync.m4a"],
    uploadedBy: "local-dev",
    status: "pending",
    errorKind: null,
    errorMessage: null,
    failedAtStage: null,
    resumeFromStage: null,
    transcriptionProgress: null,
    durationSeconds: null,
    createdAt: seedCreatedAt,
    updatedAt: seedUpdatedAt,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Customer interview — Acme",
    sourceFilenames: ["acme-interview-part-1.wav", "acme-interview-part-2.wav"],
    uploadedBy: "local-dev",
    status: "transcribing",
    errorKind: null,
    errorMessage: null,
    failedAtStage: null,
    resumeFromStage: null,
    transcriptionProgress: 42,
    durationSeconds: 3_184,
    createdAt: new Date("2026-05-03T14:30:00.000Z"),
    updatedAt: seedUpdatedAt,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    title: "Engineering retro",
    sourceFilenames: ["engineering-retro.mp3"],
    uploadedBy: "local-dev",
    status: "done",
    errorKind: null,
    errorMessage: null,
    failedAtStage: null,
    resumeFromStage: null,
    transcriptionProgress: null,
    durationSeconds: 2_745,
    createdAt: new Date("2026-05-02T16:00:00.000Z"),
    updatedAt: seedUpdatedAt,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    title: "Ops incident review",
    sourceFilenames: ["ops-incident-review.mov"],
    uploadedBy: "local-dev",
    status: "error",
    errorKind: "transcription_empty",
    errorMessage: "No speech was detected in the uploaded recording.",
    failedAtStage: "transcribing",
    resumeFromStage: "transcribing",
    transcriptionProgress: 100,
    durationSeconds: 612,
    createdAt: new Date("2026-05-01T11:15:00.000Z"),
    updatedAt: seedUpdatedAt,
  },
] satisfies DevelopmentMeetingSeed[];
