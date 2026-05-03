# ADR 0005 — Speaker mapping is cosmetic; one LLM call per Meeting

**Status:** Accepted
**Date:** 2026-05-01

## Context

The pipeline (transcribe → diarize → summarize) runs end-to-end automatically.
The LLM produces the Summary while the transcript still uses speaker labels
(`SPEAKER_00`, `SPEAKER_01`) — the user has not yet mapped them to real names.

Real names can come from three sources, and they can disagree:

1. Names spoken in the audio content ("Atila, can you handle this?").
2. Self-identification ("Hi, this is Marko...").
3. The user's post-hoc speaker mapping.

Two design questions follow:
- **When does mapping happen?** Automatic pipeline vs. paused for mapping
  before summary.
- **Does the summary regenerate when mapping changes?** Yes (more polish,
  more cost) vs. no (display-time substitution only).

## Decision

### Speaker mapping is cosmetic-only

A user-supplied speaker mapping **never re-invokes the LLM**. There is
exactly **one LLM call per Meeting**. The Summary stored at the end of the
pipeline is canonical and immutable for the lifetime of that Meeting.

Mapping changes are applied at **display time**: the UI substitutes mapped
names wherever it sees a speaker label, in both the transcript view and the
rendered Summary.

### Summarization prompt rules

The LLM is instructed to:

- Use a real name when it is clearly named in the transcript content
  (e.g. "Atila will follow up").
- Otherwise refer to people by their speaker label (`SPEAKER_00`).
- Produce action item owners using a discriminated representation (see
  data model change below).

### Data model: tighten `ActionItem.owner`

The PRD's `actionItems: { owner: string, task: string }[]` is replaced
with a discriminated union:

```ts
type ActionItem = {
  task: string;
  owner:
    | { kind: 'name'; value: string }       // content-derived, e.g. "Atila"
    | { kind: 'speaker'; value: string }    // label-derived, e.g. "SPEAKER_00"
    | { kind: 'unknown' };                  // genuinely no owner
};
```

The LLM is required to output one of these three shapes per action item.
The display layer renders:

- `kind: 'name'` — render `value` as-is.
- `kind: 'speaker'` — look `value` up in `speaker_map`; show the mapped
  name if present, else the raw label.
- `kind: 'unknown'` — render a muted "Unassigned" pill.

## Consequences

- **One OpenRouter call per Meeting.** Predictable cost, no runaway billing
  from a "regenerate" button.
- **The Summary in the database is immutable.** It is written once when the
  pipeline finishes and never updated by mapping changes.
- **The summary prompt has a contract.** Whatever LLM is configured must
  produce action item owners in the discriminated shape. The Python worker
  is responsible for validating the LLM response against this schema and
  rejecting (= `Meeting.status='error'`) if it doesn't conform.
- **Speaker labels in summary prose ("SPEAKER_00 raised concerns...") are
  substituted at render time** by the web UI's display logic, not by
  rewriting the stored Summary. This works only if the LLM uses the literal
  label strings consistently — the prompt must enforce this.
- **No "regenerate summary" button in v1.** If the team later wants
  higher-polish summaries that always use real names, the upgrade path is
  clear: add a regenerate action that re-runs the prompt with mapped names
  injected. This is a Phase 2 concern.
