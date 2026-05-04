# ADR 0010 — Drizzle (web) owns the schema; worker mirrors narrowly in Python

**Status:** Accepted
**Date:** 2026-05-04

## Context

Per ADR 0004, both services write to the `meetings` table: `web` inserts
new rows on upload, `worker` updates status / progress / error fields as
the pipeline runs. Both sides therefore need a representation of the
same Postgres schema — but in two different languages (TypeScript and
Python) without any shared build artifacts (per ADR 0009).

Three migration-ownership patterns were considered:

- **Web-owned migrations** (Drizzle in `/web`). Web is the entry point —
  rows are *created* there; worker only mutates. Drizzle's generated TS
  types flow directly into RRv7 loaders/actions with no codegen step.
- **Neutral SQL migrations** at `/db/migrations/*.sql`, applied by a
  language-agnostic runner (dbmate, sqlx-migrate, etc.). Conceptually
  clean — neither service is privileged — but introduces a third tool
  whose migration runner doesn't earn its keep at v1's scale.
- **Worker-owned migrations** (Alembic in `/worker`). Uncommon for a
  web-first product; would force web devs to context-switch into Python
  to evolve the schema.

For the Python side, several "stay in sync" strategies were considered:

- **Full Python mirror** of every column the schema defines. High
  maintenance — Python ends up restating tables it never reads.
- **Narrow Python mirror** of only the columns the worker reads or
  writes. Tiny — ~5–8 fields. Low drift surface.
- **Codegen from the TS schema file** or **DB introspection at startup**.
  Both eliminate manual sync but add brittleness: TypeScript isn't a
  stable IR; introspection adds a generation step in CI. The maintenance
  saved is small because the mirror surface is already small.
- **No Python types at all** — raw `asyncpg.Record` field access by
  string. Loses Python autocomplete and refactor safety even where it
  would be cheap to keep.

## Decision

`/web` owns the database schema. Drizzle defines it in
`web/app/db/schema.ts`; Drizzle Kit (`drizzle-kit migrate`) generates
and applies migrations. The migration files live under
`web/app/db/migrations/`.

**There is no separate `/db/` folder at the repo root.**

The Python worker maintains a **narrow manual mirror** of just the
columns it reads or writes — currently a small dataclass of around
5–8 fields (id, status, audio path, transcription progress, error
fields). Columns the worker never touches (e.g. `title`, `uploadedBy`)
have no Python representation. Drift is bounded by code review: any
PR that adds a column the worker uses must also update the dataclass.

For the LISTEN / NOTIFY connection (per ADR 0004), web uses raw
`postgres.js` directly — Drizzle is for query-time inference, not for
pub/sub connection lifecycle. Both can share the same `postgres.js`
instance.

## Consequences

- **Drizzle Kit is the only migration tool in the stack.** No second
  tool, no neutral SQL folder, no Alembic.
- **Schema changes are a TypeScript-first activity.** A web developer
  who has never seen the worker can evolve the schema; a Python-only
  contributor cannot. Acceptable given web is the dominant surface area.
- **Worker has no ORM.** It uses `psycopg3` directly with hand-written
  SQL and the narrow dataclass. ADR 0004's "hand-roll 50–100 lines of
  Python" ethos extends to the data layer.
- **Migration PR template / checklist must include:** "If this changes
  columns the worker reads or writes, also update
  `worker/src/db/models.py`." Cheap insurance against drift.
- **Schema documentation lives in `web/app/db/schema.ts`** (Drizzle's
  schema file is canonical). The Python dataclass is intentionally
  partial and should not be read as the source of truth.
- **`CONTEXT.md` describes the *domain* (Meeting, Transcript, Summary,
  etc.); the schema file describes the *physical model*.** They overlap
  but should not be conflated. CONTEXT.md is the language; schema.ts
  is the implementation.
- **Reversal cost:** moving to a neutral SQL migrations folder later is
  feasible (Drizzle can be pointed at existing migrations) but mid-flight
  switches are painful. Worth revisiting only if a non-web service ever
  needs to *create* rows in the same schema.
