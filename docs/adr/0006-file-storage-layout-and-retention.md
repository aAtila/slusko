# ADR 0006 — File storage layout and retention

**Status:** Accepted
**Date:** 2026-05-01

## Context

Per Meeting we deal with several artifacts of very different sizes:

- The uploaded original (MP3/M4A/WAV/MP4) — typically tens to hundreds of MB.
- A normalized 16 kHz mono WAV that ffmpeg produces for Whisper —
  uncompressed PCM s16le mono @ 16 kHz, ~115 MB per hour
  (32 KB/sec × 3600). For compressed source recordings (MP3/M4A/MP4) the
  normalized WAV is often **larger** than the original; for raw/uncompressed
  sources it is smaller. Storage planning should assume ~115 MB/hour for
  `normalized.wav`.
- The transcript (segments + timestamps + speaker labels) — KB-range.
- The Summary (JSON) — KB-range.
- Markdown / plain-text exports.

ADR 0001 commits us to local disk on a Docker host for v1, with an eventual
migration to a public-domain server. We need to define where artifacts live,
how long they live, and how exports are produced — without picking choices
that block the future migration or push us toward a redesign.

## Decision

### Files vs. database

- **Audio files** (original upload, normalized WAV) live on disk.
- **Transcript and Summary** live in Postgres as JSONB columns. They are not
  separate files.
- **Exports** are *never* stored. They are generated on the fly at download
  time from the current Summary + transcript_segments.

### Storage layout

A single Docker named volume **`slusko_meetings`** is mounted at
`/data/meetings` in both the `web` and `worker` containers. Per-Meeting
artifacts live in a UUID-keyed directory:

```
/data/meetings/
  <meeting_uuid>/
    original.<ext>      # uploaded file, kept until normalization succeeds
    normalized.wav      # 16 kHz mono, the canonical audio for re-processing
```

No bind mounts in v1. No MinIO / S3 in v1. The migration path to S3 later
is a single storage-adapter swap, not a redesign.

### Retention

- The **uploaded original is deleted as soon as normalization succeeds**.
  Once `normalized.wav` exists and is verified, `original.<ext>` is removed
  in the same transactional step that advances the Meeting status.
- The **normalized WAV is kept for the lifetime of the Meeting**, so the
  pipeline (transcription, diarization) can be re-run later without
  requiring the user to re-upload. This is also what enables a future
  Phase 2 "audio player on timestamp click" feature.
- A user-initiated **"delete meeting"** action removes:
  1. the `<meeting_uuid>/` directory and all files in it,
  2. the Meeting row and any related rows (segments, summary).
  Soft-delete (`deletedAt`) is acceptable for the DB row if recoverability
  is wanted later; the audio files are hard-deleted regardless because
  soft-deleted meetings cannot be reprocessed.

### Maximum upload size

- Default **`MAX_UPLOAD_MB=1024`** (1 GB). Configurable via env var.
- Server-side enforced — both the React Router upload route and the
  Postgres `meetings` insert path must reject above the cap.

## Consequences

- A 90-minute meeting normalizes to ~173 MB on disk regardless of source
  format. For a 150 MB compressed MP4 source the normalized WAV is
  slightly larger; for a raw WAV source it is smaller. Storage is
  dominated by `normalized.wav` (the original is deleted after
  normalization succeeds).
- All audio path operations go through a single helper (e.g.
  `meetingDir(meetingId)`) so the layout convention is enforced in one
  place, not strewn across the codebase.
- The "regenerate transcript with a newer Whisper" workflow remains open
  forever — we don't need the user's original file again.
- Backups are simple: snapshot Postgres + `slusko_meetings` volume. Nothing
  else holds state.
- On the eventual public-domain migration, the volume is rsync-able to the
  new host as-is. No path rewrites needed.
- Beyond 1 GB uploads, the browser-side UX gets bad enough that chunked
  upload is required — explicitly a Phase 2 problem, not a v1 one.
