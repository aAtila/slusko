# ADR 0014 — Health monitoring via a worker-written Postgres row

**Status:** Accepted
**Date:** 2026-05-08

## Context

Slusko needs an in-app way to answer "is everything actually working?" — for
manual incident triage, smoke-testing a deploy, and as a starting point when
something feels wrong. The relevant dependencies are: Postgres
(per [ADR 0004](./0004-postgres-as-queue-single-worker.md)), the worker
process itself, OpenRouter (per
[ADR 0002](./0002-cloud-llm-via-openrouter-for-summarization.md)), Hugging
Face (the source of the pyannote model and the gated-token validator), the
ffmpeg subprocess used for audio normalization, the Whisper / pyannote model
caches under `MODEL_CACHE_DIR`, the meetings storage volume, and the
`OPENROUTER_MODEL` / `HF_TOKEN` config presence.

Two structural facts shape this:

- **The web service does not have HF or OpenRouter credentials.** Per
  `docker-compose.yml` and `docker-compose.prod.yml`, only the `worker`
  service is wired with `HF_TOKEN` and `OPENROUTER_API_KEY`. Per ADR 0002,
  this is intentional: the OpenRouter integration lives behind a
  `Summarizer` interface in the worker; the web has no business knowing
  the keys.
- **The worker is a strictly serialized synchronous loop** (ADR 0004). While
  `PipelineProcessor.process(meeting)` is running — up to ~1 hour for a CPU
  transcription — the queue loop cannot do anything else. Heartbeats
  emitted from inside that loop would only fire between meetings.

The intended consumer is a human (manual `curl` / browser hit during
incidents, plus a smoke check after deploy) — **not** a platform-level
liveness probe polled every 10s. Coolify's existing container-level health
already covers "the process is responding"; this route's job is the
upstreams.

Alternatives considered:

- **Web does everything.** Pass `HF_TOKEN` / `OPENROUTER_API_KEY` into the
  web container too and have `/api/health` validate them directly.
  Rejected — punches a hole through ADR 0002's interface boundary; once the
  web has those keys it's tempting to also call those services from the web
  in some future feature, blurring "summarizer is owned by the worker."
- **Worker exposes its own HTTP `/health`, web aggregates over HTTP.**
  Rejected — adds a brand-new HTTP surface (port mapping, framework choice,
  lifecycle inside the queue process) to a worker that today has none. New
  concurrency model on top of the queue loop.
- **No dedicated heartbeat — the active meeting *is* the heartbeat.**
  Rejected — couples `/health` interpretation to pipeline state ("is
  there a non-terminal meeting whose `updated_at` is recent?"), and
  collapses two genuinely different signals ("process is alive" vs "work
  is progressing") into one. The triage value of distinguishing
  "worker dead, restart it" from "worker alive but whisper hung,
  investigate the model" is real.
- **Always-200 with status in the body.** Rejected — defeats the smoke-test
  use case (`curl --fail` exit codes).
- **Per-check rows in a `worker_health_checks` table.** Rejected — two
  tables for one feature; the existing JSONB-with-`$type<>` pattern from
  `summaries.actionItems` already covers our needs and keeps the worker
  write path to a single UPSERT.
- **Env-overridable cadences and timeouts.** Rejected for v1 — six new
  env vars for a route nobody hits 100 times a day is bloat, and there is
  no operator who would actually retune them. Promote to env later if real
  pain shows up.

## Decision

Health is reported through a single Postgres row that **the worker writes**
and **the web reads**. The web exposes `GET /api/health` as a JSON-only
React Router loader; everything observable about Slusko's health is in that
response.

### Schema

A new `worker_health` table, defined in `web/app/db/schema.ts` per
[ADR 0010](./0010-drizzle-owns-schema-worker-mirrors-narrowly.md):

- `id text primary key default 'singleton'` with a check constraint
  `CHECK (id = 'singleton')`. Only ever one row in v1 (worker is a
  singleton per ADR 0004); the constraint enforces the invariant at the
  schema level so a future bug can't write a second row.
- `worker_started_at timestamptz not null` — bumped on each worker boot.
  Lets `/api/health` show uptime and lets the web composer detect
  preserved-but-stale `checks` from the previous run.
- `last_seen_at timestamptz not null` — heartbeat. Refreshed on every
  heartbeat tick using Postgres `now()` (DB clock, not worker clock).
- `checks jsonb not null default '{}'::jsonb` — typed via Drizzle
  `$type<WorkerCheckResults>()`, mirroring how `summaries.actionItems`
  is typed. Each entry is **`{ ok: boolean, detail: string }`** — no
  per-check timestamp; the round-level `checks_refreshed_at` covers it.
  Adding a new check is a code change on both sides, no migration.
- `checks_refreshed_at timestamptz` (nullable) — set by Postgres `now()`
  whenever the daemon thread writes a fresh probe round. **This is the
  authoritative "how fresh are the upstream verdicts?" timestamp** and
  the one used for `?fresh=1` synchronization. Nullable so the bootstrap
  row can exist before the first probe round runs.
- `updated_at timestamptz not null default now()`.

Using DB-side `now()` for both `last_seen_at` and `checks_refreshed_at`
sidesteps any clock skew between the worker container and Postgres
(Coolify-managed Postgres in prod per ADR 0012). The worker writes via
raw psycopg + a narrow Python mirror per ADR 0010.

### Worker mechanics: a daemon thread

The worker grows a single new daemon thread. Lifecycle ordering in
`main.py` matters: the daemon **starts inside the singleton advisory
lock**, after `worker_singleton_lock(config)` is acquired, and **before**
the queue loop enters. Starting the daemon outside the lock would let a
losing second worker process briefly write the singleton row before its
lock acquisition fails — small window, real bug. Shutdown is the reverse:
the daemon thread is signaled via `stop_event` and joined before the lock
is released.

The thread:

- Holds its **own** psycopg connection in autocommit mode (psycopg
  connections are not thread-safe to share with the queue loop's
  connection).
- `LISTEN`s on a new channel `health_check_requested` (separate from
  `meetings_pending`, which the queue loop owns).
- Bootstraps the row once at startup with `INSERT ... ON CONFLICT (id)
  DO UPDATE SET worker_started_at = now(), last_seen_at = now(),
  updated_at = now()`. The existing `checks` JSONB and
  `checks_refreshed_at` are intentionally **preserved** — keeps the
  previous run's verdicts visible to the operator during the boot
  window before the thread runs its first probe round. The web
  composer is responsible for marking these as stale (see Web
  mechanics): `checks_refreshed_at < worker_started_at` ⇒ stale.
- Wakes on a 1s slice and tracks two timers:
  - **Heartbeat tick** every **60 seconds** — `UPDATE worker_health SET
    last_seen_at = now(), updated_at = now() WHERE id = 'singleton'`. No
    upstream calls.
  - **Upstream probe round** every **30 minutes**, plus once at startup,
    plus every time a `health_check_requested` notification is received.
    Each round runs the probe coordinator (HF whoami, OpenRouter
    `/auth/key`, ffmpeg `-version`, model-cache presence, models-dir
    disk free, config presence) and writes the full
    `WorkerCheckResults` map atomically with `checks_refreshed_at =
    now()`.
- Cooperates with the existing `stop_event` for clean shutdown.

**Internal split for testability.** The thread is implemented as two
layers: a deterministic *scheduler core* (an injectable monotonic clock,
writer, probe coordinator, listener, and `stop_event`; exposes a
`tick_once()` boundary suitable for unit tests) and a thin *thread
bootstrap wrapper* (`threading.Thread(daemon=True)`, starts the loop,
joins on shutdown). Tests target the core; the bootstrap is small enough
to cover with a single integration smoke test.

This is a deliberate departure from ADR 0004's "single-threaded worker
loop." The departure is narrow and bounded — the daemon thread does
exactly one thing (write its own row), shares no state with the queue
loop, and never claims work. The queue loop, the pipeline, and the
singleton advisory lock are unchanged.

### Upstream probe behavior

Each probe is a small function returning `{ ok: bool, detail: str }`.
Probes do **not** stamp their own timestamp; the coordinator writes
`checks_refreshed_at = now()` once per round when persisting the
result. Centralizing the timestamp avoids per-probe clock concerns and
makes "all the verdicts in this row were observed at the same instant"
true by construction.

- **HF:** `GET https://huggingface.co/api/whoami-v2` with the
  configured bearer token. Free, validates the token specifically — the
  failure mode this catches is the "ticking-bomb expired token" case
  where pyannote keeps working off the model cache until the next
  worker restart.
- **OpenRouter:** `GET https://openrouter.ai/api/v1/auth/key` with the
  configured key. Free (no LLM call, no token charge), validates the
  key.
- **ffmpeg:** `subprocess.run(["ffmpeg", "-version"], timeout=2)`.
  Verifies the binary is on `PATH` and runnable.
- **Model-cache presence:** the configured `WHISPER_MODEL` and
  `PYANNOTE_MODEL` directories exist under `MODEL_CACHE_DIR`. The probe
  checks for the presence of the model directory only; it deliberately
  does *not* poke at Hugging Face cache internals (file layout there
  changes between library versions).
- **Models-dir disk free:** `shutil.disk_usage(MODEL_CACHE_DIR)`. The
  probe is `ok` when free space is **≥ 5 GiB** (a fresh whisper-large-v3
  + pyannote download is comfortably under that). Below the threshold,
  the probe returns red with the actual free bytes in `detail`.
- **Config presence:** verifies the config fields the worker tolerates
  being absent *at startup* but requires for actual processing — i.e.
  `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `HF_TOKEN`. `DATABASE_URL`
  is not in this set because the worker fails fast on its absence and
  cannot start the health daemon at all without it. (See `config.py` —
  `load_config` raises only on missing `DATABASE_URL`; the others are
  optional with defaults / `None` and surface here.)

**The health code path uses its own HTTP timeout (5s per probe), not
the existing `OPENROUTER_TIMEOUT_SECONDS` (which is sized for real
summarization calls and is far too generous for a probe).**

### Web mechanics

`web/app/routes/api.health.ts` exposes a `loader` (no UI route, no
default export). It composes:

1. **Postgres connectivity** — `select 1` via the existing `db` client.
   `MEETINGS_STORAGE_DIR` exists / writable / free space (≥ 1 GiB) is
   checked alongside; web checks *its own* `MEETINGS_STORAGE_DIR`, not
   the worker's `MEETINGS_DIR`; they happen to be the same volume in
   compose but are owned independently per side.
2. **The `worker_health` row.** Read via Drizzle, then **parsed through
   a Zod schema** — `$type<>()` is compile-time only and the JSONB is
   written by another process in another language, so a runtime
   contract check is non-negotiable. Malformed JSON produces a degraded
   verdict with a clear `detail`, never a route crash.
3. **Liveness derivation.** Heartbeat is "stale" at **3× the heartbeat
   interval (180 s)**. If the row doesn't exist at all (e.g. clean DB
   before the worker has booted), web treats this as
   `worker.alive: false, worker.neverSeen: true`.
4. **Probe-round freshness derivation.** Compare `checks_refreshed_at`
   to `worker_started_at`. If `checks_refreshed_at` is null *or* older
   than `worker_started_at` (preserved from the previous run), the
   composer marks the entire `checks` block as **stale**, contributing
   to a `degraded` verdict even when each individual entry's `ok: true`.
   The body explicitly surfaces the staleness flag so the operator sees
   *why* the route is degraded during the boot window.
5. **Status decision.** A4 (the response composer) is a pure function
   over (local checks, parsed health row, `now()`). It owns the
   `200`/`503` decision and the canonical JSON shape; the route loader
   is glue.

### `?fresh=1` semantics

Smoke tests after deploy and incident triage that wants up-to-the-second
verdicts can bypass the 30-min cache:

1. Web captures `requestStartedAt` from Postgres (`select now()`).
2. Web `NOTIFY health_check_requested`.
3. Web polls the row every **250 ms** until
   `checks_refreshed_at >= requestStartedAt` (both timestamps are DB
   clock, so this comparison is correct regardless of any worker /
   Postgres clock skew) or **8 s** total wait.
4. On timeout, web returns whatever's currently in the row plus
   `freshRequested: true, freshFulfilled: false`. The status code still
   reflects the (possibly stale) verdict.
5. The worker side does **not** debounce — every notification triggers a
   probe round. Concurrent `?fresh=1` requests may cause duplicate work,
   which is acceptable; probes are cheap and the failure mode is
   self-limiting.

### Status code semantics

- **HTTP 200** — `status: "ok"`. Postgres reachable, worker heartbeat
  fresh, every entry in `checks` is `ok: true`, every local check
  passes.
- **HTTP 503** — `status: "degraded"`. Anything red, missing, or stale
  beyond its threshold. Body is the same JSON shape as the 200 case so
  the operator can read which dependency is the problem.
- Postgres-down is its own degenerate case: web returns **HTTP 503**
  with a partial body that explicitly notes `postgres.ok: false` and
  flags `checks` as unavailable (we can't read the row).

### Operational defaults

| Knob | Value | Where |
|---|---|---|
| Heartbeat write interval | 60 s | worker constant |
| Upstream probe interval | 30 min | worker constant |
| Per-upstream HTTP timeout (health path) | 5 s | worker constant |
| Heartbeat-stale threshold | 180 s (3× heartbeat) | mirrored on worker + web |
| Web wait on `?fresh=1` | 8 s | web constant |
| Web poll interval while waiting | 250 ms | web constant |

All hardcoded as module constants in v1, no env vars. The worker asserts
at startup that `HEARTBEAT_STALE_THRESHOLD_SECONDS == HEARTBEAT_INTERVAL_SECONDS * 3`
so the magic-number relationship can't silently drift.

## Consequences

- **ADR 0004's "single-threaded worker" is narrowed, not revoked.** The
  queue loop, the pipeline, and the `pg_try_advisory_lock` singleton
  are unchanged. The new daemon thread is bounded to writing its own
  row and listening for `health_check_requested`. No claim, no pipeline
  participation, no shared state.
- **A new Postgres NOTIFY channel** (`health_check_requested`) joins
  `meetings_pending` (ADR 0004). The worker now `LISTEN`s on two
  channels from two different connections.
- **`worker_health` becomes part of the schema** Drizzle owns
  (ADR 0010). The worker maintains its narrow Python mirror for the
  three columns it writes (`worker_started_at`, `last_seen_at`,
  `checks`). The migration PR template's "if you change a column the
  worker uses, update the dataclass" rule applies here too.
- **The web learns no new secrets.** `HF_TOKEN` and
  `OPENROUTER_API_KEY` stay confined to the worker per ADR 0002.
- **`MEETINGS_STORAGE_DIR` becomes a documented web env.** Both
  `docker-compose.yml` and `docker-compose.prod.yml` set it explicitly
  for the `web` service (default `/data/meetings`, matching the
  worker's `MEETINGS_DIR`). `.env.example` documents it. Nothing else
  about the volume layout changes.
- **Probes are off the budget hot path.** 30-min cadence × 2 free
  endpoints × 1 worker = ~96 probes/day. Well under any rate limit and
  costs nothing because both probe endpoints are zero-charge metadata
  reads. `?fresh=1` adds at most one extra round per manual hit.
- **Ticking-bomb failures are detected within ~30 minutes**, not at the
  next worker cold start. This is the main qualitative improvement: an
  HF token revoked at 03:00 stops being invisible for the rest of the
  week.
- **A hung whisper is distinguishable from a dead worker.** Heartbeat
  freshness reflects process aliveness; `transcription_progress`
  staleness on an in-flight meeting reflects pipeline progress. An
  operator reading `/api/health` plus the meeting list can tell the
  two states apart, which conflated approaches (heartbeat-from-the-loop
  or active-meeting-as-heartbeat) cannot.
- **No history table.** Only the latest snapshot is kept. If we ever
  need "was OpenRouter flapping yesterday?" we'd add an append-only
  `worker_health_log` later. Out of scope for v1.
- **Reversal cost is meaningful but localized.** Removing the daemon
  thread, the table, and the route is a few hundred lines of mechanical
  deletion. Switching to a worker-side HTTP `/health` later would force
  re-deciding container/port wiring; we'd revisit the architecture
  decision rather than mechanically migrate.
- **No new env vars in v1.** Six tuning knobs are hardcoded as module
  constants. Promoting any of them to `WorkerConfig` later is trivial;
  deprecating an env var operators have learned to set is harder, so we
  default to constants.

## See also

- [ADR 0001](./0001-dockerized-self-hosted-deployment.md) — internal-network
  v1, no in-app auth. The lack of auth is why `/api/health` returns full
  diagnostic detail without gating.
- [ADR 0002](./0002-cloud-llm-via-openrouter-for-summarization.md) — the
  reason web doesn't have OpenRouter credentials and therefore the reason
  health probes have to live in the worker.
- [ADR 0004](./0004-postgres-as-queue-single-worker.md) — the
  Postgres-as-coordination-substrate ethos this ADR extends from "the
  queue" to "the health bulletin board," and the single-threaded-worker
  stance this ADR narrows.
- [ADR 0010](./0010-drizzle-owns-schema-worker-mirrors-narrowly.md) — why
  `worker_health` is defined in `web/app/db/schema.ts` and why the
  worker keeps a narrow Python dataclass for the columns it writes.
- [ADR 0012](./0012-coolify-managed-postgres-in-prod.md) — Coolify's
  pre-deploy migration step is what guarantees the `worker_health` table
  exists before the worker boots in prod.
