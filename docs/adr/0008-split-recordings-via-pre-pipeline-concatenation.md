# ADR 0008 — Split recordings: concatenate before the pipeline

**Status:** Accepted
**Date:** 2026-05-02

## Context

Recordings sometimes split mid-meeting: the recorder app crashes, the
phone runs out of battery, someone restarts to "make sure it's saving."
The user ends up with two (or more) audio files that represent **one
conversation**. The PRD's data model assumes 1 file = 1 Meeting.

The technical wrinkle: pyannote-audio assigns speaker labels per-clip,
arbitrarily. If we process two parts separately, `SPEAKER_00` in part 1
is not the same person as `SPEAKER_00` in part 2. Stitching their
transcripts post-hoc requires either voice-embedding comparison across
clips (a different model and a different problem) or asking the user
to manually match speakers between parts (poor UX). The summary also
loses cross-part context if generated separately.

We considered:

- **Two Meetings + a "merge" button** that runs voice-embedding speaker
  alignment and re-summarizes. Rejected: pulls in pyannote's embedding
  pipeline and a re-summarize cost path we explicitly avoided in
  ADR 0005.
- **Force users to concatenate themselves** with ffmpeg / Audacity
  before uploading. Rejected: violates the PRD's "non-technical users"
  requirement.
- **Skip the case in v1**, accepting that split-recording meetings just
  produce two disjointed Summaries. Rejected: this is a real workflow
  the team will hit immediately.

## Decision

Split recordings are a **first-class upload-time option**. Multiple
audio files become a single Meeting whose canonical audio is the
**concatenation of normalized WAVs** of each part.

### UX

- When multiple files are added in one upload action, the confirmation
  panel defaults to "N separate meetings" (matching the bulk-upload
  case). A toggle says **"These are parts of one meeting"**, switching
  to split-recording mode.
- In split-recording mode, files are an ordered list (drag to reorder).
  Submit creates **one** Meeting with N source parts.
- There is **no merge-after-the-fact** in v1. A user who forgot to mark
  it at upload time deletes the per-part Meetings and re-uploads.

### Pipeline

- Per-part originals are stored under
  `<meeting_uuid>/originals/part-N.<ext>` until normalization succeeds.
- Normalization stage:
  1. ffmpeg each part to a temporary 16 kHz mono WAV.
  2. Concatenate the temporary WAVs into the final
     `<meeting_uuid>/normalized.wav`.
  3. Delete `originals/` (per ADR 0006).
- Transcription, diarization, and summarization run **once** on the
  concatenated audio. Speaker labels are therefore consistent across
  all parts by construction.

### Data model

`Meeting.sourceFilenames: string[]` — one entry for ordinary uploads,
N entries for split recordings. The UI renders this as
"Recorded in N parts: part1.mp4, part2.mp4" on the meeting page when
N > 1; hidden when N == 1.

## Consequences

- The "1 file = 1 Meeting" mental model is preserved at the data layer
  for everything *after* normalization. Only the upload form and the
  normalization stage are aware of multi-part inputs.
- Concatenating already-normalized WAVs sidesteps the problem of
  mismatched source formats across parts (one MP4, one M4A, etc.).
- A subtle audible click can occur at part boundaries in the
  concatenated WAV. This is invisible to Whisper / pyannote (it just
  registers as a brief silence). It would be a Phase 2 audio-player
  concern; solvable later with a short crossfade at concat time.
- The normalization stage is now multi-step and slightly more expensive
  for split recordings, but the cost scales linearly with parts and is
  trivial compared to transcription.
- A future "merge two existing Meetings" feature is explicitly *not*
  built. If the team asks for it later, the right path is voice-
  embedding speaker alignment + transcript stitching + re-summarize,
  which is a meaningful piece of work and should get its own ADR.
