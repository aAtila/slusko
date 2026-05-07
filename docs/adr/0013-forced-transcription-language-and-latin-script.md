# ADR 0013 — Forced transcription language with Serbian default, transcripts always in Latin script

**Status:** Accepted
**Date:** 2026-05-07

## Context

CONTEXT.md's earlier "Language handling" rule said the worker uses
Whisper auto-detection (`language=None`) and there is no upload-time
language picker. The reasoning was that `large-v3` handles Serbian +
English code-switching well enough that forcing a language would make
things worse, not better.

Trial uploads of real Slusko recordings showed the opposite:

1. **Auto-detect misclassifies as Croatian.** Across 4–5 test runs of
   Serbian meetings, Whisper picked `en` once and `hr` (Croatian) every
   other time. It never picked `sr`. Croatian is higher-resource than
   Serbian in Whisper's training data, so close-language ties skew
   toward `hr`. The resulting transcript reads as Croatian-flavored
   mush to a Serbian audience.
2. **Recordings often start with silence or noise.** Many uploads have
   a couple of minutes of nothing or low-energy ambient noise at the
   head. Whisper's auto-detection runs on the first ~30 s of audio, so
   this class of recording defeats detection by construction.

These are not theoretical concerns; they were observed before this ADR
was written. The earlier policy was wrong for this codebase's actual
inputs.

A second, independent concern: Whisper's `sr` head outputs **Cyrillic
Serbian** by default. The team prefers Latin script for in-app reading
and exports.

## Decision

### Three-way upload-time language picker, default Serbian

Each Meeting has an explicit transcription-language choice made at
upload time:

- **Serbian** (default — the 80% case)
- **English** (the 20% case — meetings with foreign clients, etc.)
- **Auto-detect** (escape hatch, kept available — nothing prevents the
  user from preferring it for a specific upload, e.g. when neither
  Serbian nor English is right)

The default is **Serbian, not auto**. This is the headline reversal:
auto-detection is no longer the default behavior because it has been
empirically shown to misfire on this team's recordings.

### Drag-and-drop uses the default; no per-drop picker

The home page's drag-drop target stays drag-drop — dropped files create
a meeting using the default language (`sr`) without a confirmation
modal. The **"+ New Meeting" button** opens a form that includes the
three-way picker. Rationale: drop-and-walk-away is Slusko's dominant
UX pitch and the default catches 80% of cases; the button form is the
explicit-control path for the remaining 20%.

The meeting list row displays the resolved language alongside duration
(`2 days ago · 47 min · Serbian`), so misclassifications are visible
post-hoc without needing a filter or a detail view.

### Always Latin script

The pipeline post-processes the transcript with a deterministic
Cyrillic→Latin transliteration before writing transcript_segments to
Postgres. Serbian Cyrillic ↔ Latin is bijective and standardised
(digraphs `Љ→Lj`, `Њ→Nj`, `Џ→Dž`, the rest 1:1), so the conversion is
mechanical and accurate.

The transliteration is applied **unconditionally** to all transcript
output — not gated on the chosen language. This way:

- Forced `sr` → Cyrillic → Latin. ✓
- Auto resolving to `sr` / `bs` / `mk` / anything Cyrillic → Latin. ✓
- Forced `en` or auto resolving to a Latin language → no-op. ✓

All downstream consumers (summary LLM call, UI, exports, search) see
Latin only. No consumer needs to know about scripts.

Implementation: the `cyrtranslit` Python library is the default choice;
a hand-rolled lookup table is acceptable if the dependency footprint
matters more than the saved code.

### Data model — two columns on `meetings`

```sql
ALTER TABLE meetings ADD COLUMN language text;            -- 'sr' | 'en' | NULL (= auto)
ALTER TABLE meetings ADD COLUMN detected_language text;   -- whatever Whisper detection picked, or NULL
```

- `language` — what the **user requested**. The worker reads this and
  passes it through to faster-whisper as `language=meeting.language`
  (i.e., `None` when `NULL`).
- `detected_language` — what **Whisper's auto-detection actually
  picked**. Populated **only when `language IS NULL`**, i.e., when auto
  ran. faster-whisper skips its internal detection step when language
  is forced, so the column would be meaningless for forced runs (it
  would just echo the forced value back) and we don't pretend
  otherwise.

Existing rows get `NULL/NULL`, which is truthful — they were processed
under the old auto-detect regime, and we don't know retroactively what
detection picked.

### Editability — pending and error-retry only

Language is editable in two moments of the meeting lifecycle:

- **`status = 'pending'`** — inline edit on the meeting detail page,
  until the worker dequeues the row. There is a race window between
  edit and dequeue (the worker holds the row under `SELECT FOR UPDATE
  SKIP LOCKED`); the worst case is that the change loses, in which
  case the user falls through to the next moment.
- **`status = 'error'`** — the manual-retry button (per ADR 0007)
  becomes a small popover with a language picker pre-filled to the
  current value. Picking a different language and retrying is the
  canonical "auto got it wrong" recovery flow.

Language is **not** editable on `status = 'done'` meetings. To
re-transcribe a successfully-processed meeting in a different
language, the user deletes and re-uploads. A "re-transcribe" button
was considered and explicitly deferred — it requires a destructive-
confirmation flow and re-introduces the regenerate-summary cost trap
that ADR 0005 closed.

### Summary language rule unchanged

The Summary continues to be written by the LLM in whichever language
dominates the transcript, with Serbian as the tiebreaker (per the
otherwise-unchanged "Language handling" rules in CONTEXT.md). Forcing
a transcription language influences the summary indirectly via the
transcript, which is the right behaviour. There is no separate
"summary language" override; users who want a Serbian summary of an
English meeting edit the rendered summary text directly per ADR 0005.

### Wire format

The upload endpoint is multipart/form-data. The Busboy parser is
relaxed from `fields: 0` to allow the single optional `language`
field; all other non-file fields stay rejected. Zod-validated on the
server. Default applied server-side when the field is absent.

## Consequences

- **The previous "no upload-time language picker" rule in CONTEXT.md
  is reversed.** Future readers should treat this ADR as the
  authoritative source. The "Language handling" section of CONTEXT.md
  is updated in the same change to reference this ADR.
- **Migration cost is small.** One `ALTER TABLE` adding two nullable
  columns. No backfill.
- **The summary prompt and rules are unaffected.** No prompt changes
  required.
- **Worst remaining failure under forced `sr`** is "transcribe English
  bursts as Latin-spelled English-ish words." With always-Latin
  post-processing, this is legible-but-wrong rather than Cyrillic-
  gibberish. The fully wrong cases (e.g. forced `sr` on an 80%-English
  meeting) are addressed by picking `en` or `auto` explicitly at
  upload time, or by the error-retry flow when transcription
  empties out.
- **Auto-detect remains available** as the third option. This ADR is
  not claiming auto-detect is broken in absolute terms — only that it
  is the wrong default for this team's recordings. Other Slusko
  deployments with cleaner audio and different language mixes can
  still benefit from it.
- **Diarization and summarization are not threaded with language.**
  They consume the transcript text directly; nothing about the
  transcription-stage language choice propagates further down the
  pipeline.
- **"Would auto have agreed?" telemetry** (running language detection
  even when forcing, to compare) is explicitly deferred. The
  ~+1 s/meeting compute tax for `model.detect_language()` is not
  justified for v1. If we later want to second-guess the default, we
  add it then.
- **Editor surface stays small.** The same `<LanguageSelect>` component
  is used in three places: the upload form, the inline edit on
  pending meetings, and the retry popover.

## Related ADRs

- [ADR 0003](./0003-faster-whisper-pyannote-cpu-flexible.md) — chooses
  faster-whisper + `large-v3`, which this ADR builds on.
- [ADR 0005](./0005-speaker-mapping-is-cosmetic.md) — establishes the
  "one LLM call per Meeting, summary not regenerated" invariant that
  this ADR's deferred "re-transcribe" decision preserves.
- [ADR 0007](./0007-pipeline-status-and-failure-semantics.md) —
  defines the retry flow this ADR extends with a language picker.
