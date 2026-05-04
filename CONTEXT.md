# Slusko — Domain Context

> Internal meeting transcription & summary tool. "Slušaj" → "listen" in Serbian.

This file captures the **ubiquitous language** of the product — terms that are
meaningful to domain experts (the team using and building Slusko). It is not a
description of the codebase or implementation details.

## Glossary

### Meeting

A single recorded conversation that has been (or is being) processed by Slusko.
The unit of work and the unit of display.

Most Meetings come from a single uploaded file, but a Meeting may also be
formed from a **split recording** — multiple files representing parts of
one conversation, concatenated before processing. See
[ADR 0008](./docs/adr/0008-split-recordings-via-pre-pipeline-concatenation.md).

A Meeting has a `title` (human-readable, e.g. "Q2 Product Strategy Meeting")
that is initially defaulted from the uploaded filename without extension and
is editable inline on the meeting page.

A Meeting moves through these statuses:

- **pending** — uploaded, queued for the worker
- **normalizing** — ffmpeg extracting/converting audio
- **transcribing** — Whisper running (carries a `transcriptionProgress` 0–100)
- **diarizing** — pyannote running
- **summarizing** — LLM call to OpenRouter in flight
- **done** — all outputs ready
- **error** — pipeline failed (carries `errorKind`, `errorMessage`, and
  `failedAtStage` so a manual retry resumes from the right point)

The state machine and retry rules are spelled out in
[ADR 0007](./docs/adr/0007-pipeline-status-and-failure-semantics.md).

### Transcript

The full text output of a Meeting, broken into Segments. Each Segment has a
start time, end time, speaker label, and text.

### Speaker label

A pipeline-assigned identifier like `SPEAKER_00`, `SPEAKER_01`. Does **not**
identify a real person — it just groups segments that the diarizer thinks came
from the same voice within one Meeting.

### Speaker mapping

The user-supplied translation from speaker label → real name, scoped to a
single Meeting. Per-meeting only in v1; cross-meeting "speaker memory" is a
Phase 3 concern.

The mapping is edited in a **dedicated "Speakers" panel** on the meeting
page — a table of `SPEAKER_NN → [textbox]` rows, saved on blur. The
transcript view and the rendered summary update live as mappings change
(per [ADR 0005](./docs/adr/0005-speaker-mapping-is-cosmetic.md), the
underlying Summary record is not regenerated). No inline-rename and no
auto-suggestions from transcript content in v1.

### Summary

The LLM-generated structured output for a Meeting. Always contains:
overview, decisions, action items (each with an owner), and open questions.

The Summary is generated **once** by the pipeline and is then **editable by
the user** in the UI (textarea for the overview, editable lists for
decisions / open questions, editable rows for action items). Edits are
last-write-wins; v1 has no versioning, audit log, or per-user attribution
on edits.

The Transcript, in contrast, is **read-only** in v1. People edit summaries
hundreds of times more often than transcripts in tools like this, and
keeping the transcript immutable also keeps the door closed on the
"regenerate the summary from an edited transcript" cost trap (see
[ADR 0005](./docs/adr/0005-speaker-mapping-is-cosmetic.md)).

### Action item

A concrete task surfaced from a Meeting. Has a `task` description and an
`owner`. The owner is a discriminated value, not a free string:

- a **name** drawn from the audio content ("Atila"),
- a **speaker label** the user has not yet mapped (`SPEAKER_00`), or
- **unknown** when neither the content nor the diarization committed
  someone to the task.

Display rules and the rationale for the union are in
[ADR 0005](./docs/adr/0005-speaker-mapping-is-cosmetic.md).

## Scope

**v1 is the PRD's MVP**, not the visual mockup. The mockup is a Phase 2/3
vision board. Specifically out-of-scope for v1: audio player, Timeline tab,
Highlights, Notes, AI Chat, Templates, Share button, global Speakers
directory, transcript editing.

## Audio normalization (the canonical ffmpeg contract)

Whisper is sensitive to **sample rate** (16 kHz) and **channel count**
(mono). Everything else is irrelevant to quality. The canonical
normalization is therefore one ffmpeg invocation, used everywhere:

```bash
ffmpeg -i <input> -vn -ac 1 -ar 16000 -c:a pcm_s16le -y <output>.wav
```

`-vn` drops any video track (screen-recorder MP4s carry one).
**No volume normalization, no denoising, no compression.** Whisper
performs better on raw audio than on cleaned audio.

For split recordings (see [ADR 0008](./docs/adr/0008-split-recordings-via-pre-pipeline-concatenation.md)),
each part is normalized to its own WAV first; the parts are then
joined with the **concat filter** (more robust than the demuxer):

```bash
ffmpeg -i part1.wav -i part2.wav -filter_complex \
  '[0:a][1:a]concat=n=2:v=0:a=1[out]' -map '[out]' \
  -c:a pcm_s16le -y normalized.wav
```

`ffprobe` runs alongside normalization to capture
`Meeting.durationSeconds`. The duration appears in the meeting list,
the meeting page header, and the export header.

## Tech stack

### Web app (React Router v7, framework mode)

- **DB / ORM:** Drizzle ORM on top of `postgres` (the JS driver).
  Drizzle Kit for migrations.
- **Validation:** Zod everywhere — request bodies, env, and the LLM
  response schema. Drizzle's Zod codegen connects schema and validation.
- **Styling:** Tailwind v4.
- **Component primitives:** shadcn/ui (Radix + Tailwind, copy-pasted —
  not a runtime dep).
- **Data fetching:** React Router v7 loaders/actions for everything.
  React Query is added **only** for the meeting-list polling.
- **Forms:** React Router's native `<Form>` + actions. No Formik, no RHF.
- **File upload:** streamed multipart parsing (Busboy-style) — never
  buffer a 1 GB upload into memory.
- **Linting:** **oxlint**. No ESLint, no Biome.
- **Formatting:** **Prettier** today as a stopgap, with the explicit
  intent to switch to **oxfmt** (the voidzero.dev formatter) once it
  ships a stable 1.0. The voidzero toolchain is the long-term home;
  Prettier is here because oxfmt is still pre-1.0 and PR-noise from
  format churn isn't worth eating on an internal tool.
- **Logging:** `pino` to stdout, JSON.
- **Tests:** Vitest.

### Worker (Python service)

- **Pipeline libraries:** `faster-whisper`, `pyannote.audio`, plus
  `ffmpeg` invoked as a subprocess.
- **DB driver:** `psycopg[binary,pool]`.
- **HTTP client:** `httpx`.
- **Validation:** `pydantic` (mirrors the web app's Zod usage for the
  LLM response schema and config).
- **Logging:** `structlog` to stdout, JSON.
- **Tests:** pytest.

### Container base images

- Web: `node:22-alpine`.
- Worker: `python:3.12-slim` — **not** alpine. Whisper PyPI wheels are
  glibc-linked; alpine forces source builds and CUDA pain.

## Notification on completion

A 1-hour meeting on CPU takes ~1 hour, so users will not stay on the page.

v1 notification is **document-title flicker only**: while the user is in
the app on any tab, the page title updates to mark a finished meeting
(e.g. `"✓ Q2 Strategy — Slusko"`). No browser push, no email, no Slack.

Slack-webhook integration is the planned Phase 2 upgrade because it's
where the team already lives. Email is rejected for an internal team —
overkill and adds an SMTP dependency.

## Meeting list (home screen)

The list page is the default landing screen. Behavior:

- **Row contents:** title, relative date ("2 days ago"), duration if known,
  and a **status indicator** that adapts to the Meeting's state:
  - `done` → quiet success treatment.
  - `error` → visually prominent (red/orange) so failed meetings stand out
    without needing a filter.
  - in-progress (`normalizing` / `transcribing` / `diarizing` /
    `summarizing`) → a **tiny progress hint** showing the current stage.
    For `transcribing`, also surface the percentage from
    `transcriptionProgress`.
- **Default sort:** `createdAt` descending (newest upload first).
- **No search** in v1 (full-text search is Phase 3 in the PRD).
- **No filter** in v1; visual prominence covers the "what failed?" need.
- **No pagination** in v1; the list loads all meetings. Revisit at ~100+.
- **No bulk actions** in v1; delete is per-meeting.
- **Drop target:** the entire list page is a file drop target. There is
  also a `+ New Meeting` button in the header for click-uploaders.
- **Live updates:** the list page polls (every ~5 s) for status changes,
  but only while at least one visible meeting is in a non-terminal status.
  Once everything visible is `done` or `error`, polling stops.
- **Empty state:** when there are no meetings, the list page shows a
  clear "no meetings yet" message with a prominent drag-and-drop /
  upload hint. This doubles as the first-run onboarding moment.

## Exports

A Meeting can be exported in two flavors:

- **Summary export** — title header (with ISO date, duration, speaker
  list), overview, decisions, action items, open questions. The default
  and most common export. Fits in a Slack message.
- **Full export** — everything in the summary export plus the full
  transcript (speaker-mapped, with `[mm:ss]` timestamps).

Both flavors are produced by a **single markdown renderer**. The
"plain text" download is the same markdown stripped of formatting at
render time — there is no separate plain-text template.

Exports are **never stored on disk** — they are generated on the fly at
download time from the current Summary + transcript_segments. This
guarantees they reflect the user's most recent edits to the Summary.

Conventions:

- Dates in exports are **ISO 8601** (`YYYY-MM-DD`). The in-app UI may
  show localized dates; exports stay ISO so they're unambiguous and
  sortable when pasted elsewhere.
- Download filenames are `{iso_date}-{slugified_title}.md`, e.g.
  `2026-04-21-q2-product-strategy.md`.

Copy-to-clipboard mirrors the two exports: **Copy summary** and **Copy
full**. No per-section copy buttons in v1.

## Language handling

Slusko is built for a Serbian + English code-switched audience.

- **Transcription** uses Whisper auto-detection (`language=None`). No
  upload-time language picker; `large-v3` handles code-switching well
  enough that forcing a language tends to make things worse, not better.
- **Summary** is written by the LLM in whichever language dominates the
  transcript. If roughly even, Serbian is the default. No upload-time
  output-language picker.
- **Technical and product terms** ("backend", "PR review", "Q2 OKRs",
  "sprint") are preserved in their original language inside summaries —
  the prompt explicitly forbids translating them. This avoids
  Serbianizing English jargon into unreadable phrases.

These are prompt-level rules, not data-model rules. Changing them later
is a prompt edit, not a migration.

## Access model (v1)

Slusko v1 runs **on the internal network only**, reachable through the
company VPN. There is **no in-app authentication** in v1. Every authenticated
VPN user is implicitly a Slusko user, and every Slusko user can see every
Meeting (shared inbox).

Each Meeting still records an `uploadedBy` string (free text, e.g. "atila")
so we keep an audit trail and have a clean place to attach real identities
when auth is added later.

The eventual public-domain deployment will require real authentication. That
work is deferred but not forgotten.
