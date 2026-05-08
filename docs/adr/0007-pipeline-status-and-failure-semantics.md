# ADR 0007 — Pipeline status state machine and failure semantics

**Status:** Accepted
**Date:** 2026-05-02

## Context

ADR 0004 made Postgres the canonical state store and named `meetings.status`
as the state machine driving the worker. The PRD's coarse states
(`pending | processing | done | error`) are too thin for two reasons:

1. **User feedback during long jobs.** Transcription on CPU can take an
   hour. A blanket `processing` for that whole time is indistinguishable
   from "the system is hung."
2. **Failure recovery.** Failures fall into categories with different right
   answers (transient retry, manual retry, "this file is broken, give up").
   `errorMessage: string` doesn't carry enough information to drive UI or
   retry logic correctly.

ADR 0004 also commits us to resumable processing (`SELECT FOR UPDATE SKIP
LOCKED` plus a startup scan). That implies the state machine must be
granular enough that "where did we stop?" is recoverable from a single
column read.

## Decision

### State machine

`meetings.status` is one of:

```ts
type MeetingStatus =
  | 'pending'
  | 'normalizing'
  | 'transcribing'
  | 'diarizing'
  | 'summarizing'
  | 'done'
  | 'error';
```

Each non-terminal status corresponds to a worker stage. The worker advances
the status transactionally as it enters each stage. `done` and `error` are
terminal.

### Progress reporting

Only the `transcribing` stage exposes a numeric `transcriptionProgress`
(0–100, nullable when not transcribing). The other stages are short enough
that the named status is sufficient signal — no per-stage progress for them.

### Error fields

When the pipeline fails, the worker writes:

```ts
{
  status: 'error',
  errorKind: ErrorKind,       // structured enum, see below
  errorMessage: string,        // human-readable, surfaced in UI
  failedAtStage: MeetingStatus // which sub-status hit the error
}

type ErrorKind =
  | 'normalization_failed'
  | 'transcription_failed'
  | 'transcription_empty'      // distinct: pipeline ran, audio had no speech
  | 'diarization_failed'
  | 'summarization_failed'
  | 'config_missing'
  | 'unknown';
```

`transcription_empty` is set after a successful Whisper run if the
transcript is essentially empty: **0 segments**, or fewer than ~10
total words *and* no segment longer than ~2 seconds (the latter
catches Whisper's "Thank you" hallucination pattern on near-silent
audio). When detected, the worker stops the pipeline immediately —
diarization and summarization are not run, no OpenRouter call is made.
The UI surfaces a distinct message ("No speech detected. The recording
may be silent, music-only, or corrupted.") rather than a generic
"transcription failed." The retry button is hidden for this kind —
retrying won't help; the user needs to upload different audio.

`failedAtStage` is what makes resumable retry possible — it tells the
manual-retry path which stage failed. Manual retry copies that value into
`resumeFromStage` while putting the row back through the normal pending queue.

### Retry rules

- **Auto-retry inside the worker** for transient errors (network,
  OpenRouter 5xx, HuggingFace 5xx): 3 attempts with exponential backoff
  at 1 s, 5 s, 25 s. The user never sees these unless they exhaust.
- **Manual retry** is a button on the Meeting page. Clicking it transitions
  the status from `error` to `pending`, copies the previous `failedAtStage`
  into `resumeFromStage`, and clears the visible error fields. `resumeFromStage`
  must be one of the worker stages (`normalizing`, `transcribing`, `diarizing`,
  or `summarizing`). The worker still claims the row through the same pending
  queue path; during claim it promotes the row to `resumeFromStage`, clears
  `resumeFromStage`, and returns that effective stage to the pipeline processor.
  The transcript and any earlier-stage outputs already in the DB are not
  re-computed.
- **Worker crash mid-stage** is recovered by the startup scan from
  ADR 0004: any non-terminal status means "pick up." The pipeline must
  therefore be **idempotent at the stage boundary** — re-entering
  `transcribing` from a crash must not produce duplicate Segment rows.
- **Hard failures** (`transcription_empty`, `config_missing`, and corrupt-audio
  shaped `normalization_failed` failures such as ffmpeg decode errors) still
  set `status='error'`. The UI hides retry and suggests the appropriate
  corrective action instead.

## Consequences

- The Meeting record carries six status-related fields total: `status`,
  `transcriptionProgress`, `errorKind`, `errorMessage`, `failedAtStage`, and
  `resumeFromStage`. All but `status` are nullable. Migration cost is small
  (one table).
- The UI has a clear, finite set of states to render — there is no
  combinatorial blowup of "processing + percent + maybe error." Each
  status is a different visual treatment.
- The worker is responsible for **stage idempotency**. Concretely: each
  stage must either be a single transactional write at the end (so
  re-running it just re-does the work, doesn't double-write), or
  delete-then-insert for that meeting's outputs at the start. The
  cheaper convention is "delete-then-insert at stage entry." Pick one
  in code review and stick to it.
- Transient retries inside the worker are invisible to Postgres — they
  do not flip the status. Only exhaustion of retries advances to `error`.
- Future "play audio at timestamp" features have a clean place to hook
  in: `transcribing` is when timestamps become available; the UI can
  enable a player as soon as `status` is past `transcribing`.
