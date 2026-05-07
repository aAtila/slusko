# ADR 0004 — Postgres-as-queue, single Python worker

**Status:** Accepted
**Date:** 2026-05-01

## Context

The React Router v7 web app (Node) and the Python worker need to communicate
job state: web inserts a job when a Meeting is uploaded, worker picks it up,
worker reports progress, web renders status to the user.

The realistic upload volume for an internal team is small — order of single
digits of meetings per day at peak. The processing cost per meeting is high
(minutes to an hour on CPU) so jobs are long-lived but rare.

We considered:

- **SQLite + polling.** Rejected: cross-process write coordination over
  Docker volumes is fragile.
- **Postgres + Redis + Celery.** Rejected: adds two new operational concerns
  (Redis container, Celery worker model) for capability we don't need at
  v1's concurrency profile.
- **Postgres + Redis + BullMQ.** Same rejection plus a language mismatch
  (BullMQ is Node-native, our worker is Python).
- **Direct synchronous HTTP from web to worker.** Rejected: cannot hold an
  HTTP request open for the duration of a 1-hour transcription.

## Decision

**Postgres is both the database and the job queue.** No Redis, no Celery,
no separate broker.

Mechanics:

- Web inserts a row into `meetings` with `status='pending'` and issues
  `NOTIFY meetings_pending` in the same transaction.
- The Python worker holds an open `LISTEN meetings_pending` connection. On
  notification it claims the next pending row using `SELECT ... FOR UPDATE
  SKIP LOCKED` and processes it.
- On worker startup, it scans for `status IN ('pending', 'processing')`
  rows to resume any work interrupted by a restart.
- Status transitions and progress fields are written back to the same row.
- The web UI reads status from the same table — no separate "live job
  state" store to desync against.

We will hand-roll this in ~50–100 lines of Python rather than pull in a
queue library. If it gets noticeably gnarlier, **`procrastinate`** is the
recommended drop-in replacement (Postgres-native, `LISTEN/NOTIFY`-based,
retries built in).

**v1 runs exactly one worker process** that processes meetings strictly
serially. No worker pool, no parallel jobs.

## Consequences

- The Docker Compose stack has three first-class services:
  `postgres`, `web`, `worker`. No fourth service for queueing.
- `meetings.status` is the canonical state machine. Workers must update it
  transactionally with the rest of their writes.
- A meeting interrupted mid-processing (worker container restart) is
  resumable on the next worker boot. Implementation must be idempotent —
  re-running the pipeline on the same Meeting row must produce the same
  result, not duplicate it.
- One worker = serialized processing = predictable resource use. A 1-hour
  meeting blocks all subsequent meetings until it finishes. Acceptable for
  v1; revisit if the team's actual upload volume causes a backlog.
- Scaling out later is a small change: run multiple worker containers
  against the same Postgres. `SELECT FOR UPDATE SKIP LOCKED` already makes
  this race-safe. No data-model change required.

## See also

- [ADR 0012 — Coolify-managed Postgres in production](./0012-coolify-managed-postgres-in-prod.md)
  narrows the "three first-class services: postgres, web, worker"
  enumeration above: in prod, the `postgres` Compose service is replaced by
  a Coolify-managed standalone Postgres resource. The queue semantics in
  this ADR (`LISTEN/NOTIFY`, `SELECT … FOR UPDATE SKIP LOCKED`,
  scan-on-boot, single-worker serialization) are unchanged.
