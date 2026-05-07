# ADR 0012 — Coolify-managed Postgres in production

**Status:** Accepted
**Date:** 2026-05-07

## Context

Per [ADR 0001](./0001-dockerized-self-hosted-deployment.md), production is a
Docker Compose stack on infra we control. Per
[ADR 0004](./0004-postgres-as-queue-single-worker.md), that stack has three
first-class services: `postgres`, `web`, `worker`.

In practice, baking Postgres into `docker-compose.prod.yml` couples its
lifecycle to the application stack in ways that hurt production hygiene:

- No backups are configured today — the `postgres_data` named volume is one
  `docker compose down -v` away from data loss.
- Postgres version bumps require redeploying the whole app stack.
- App rollouts and database operations share the same blast radius.
- Migration is a manual two-step (`docker compose -f docker-compose.prod.yml
  up -d`, then `docker compose -f docker-compose.prod.yml run --rm migrate`),
  easy to forget, with no atomicity between schema changes and code rollout.

Alternatives considered:

- **Status quo (Postgres stays in `docker-compose.prod.yml`).** Rejected —
  the coupling above gets worse the longer the app runs, and "no backups"
  isn't a tenable v1 endgame.
- **Standalone Postgres reachable from an operator laptop, with migrations
  run from the laptop.** Rejected — makes the laptop a load-bearing part of
  the deploy pipeline, spreads prod credentials onto developer machines,
  and normalizes manual prod mutation as the deploy story.
- **External managed Postgres** (Neon, Supabase, RDS, Crunchy). Rejected —
  breaks ADR 0001's "centralized on infra we control" stance for the data
  tier, and is over-investment for an internal-VPN-only v1 with single-digit
  meetings/day.

## Decision

Postgres for **production** is provisioned as a **standalone
Coolify-managed Database resource**, sibling to the app stack on the same
Coolify host, reachable from `web`, `worker`, and the migration runner over
Coolify's internal Docker network.

- **Version:** Postgres 18, matching `docker-compose.yml`'s dev pin so dev
  and prod stay on the same major.
- **Connection string:** `DATABASE_URL` is set **manually** in the app's
  Coolify environment config — single source of truth, no Coolify magic
  envs (`SERVICE_URL_*`) baked into checked-in compose files.
  `docker-compose.prod.yml` keeps its existing
  `${DATABASE_URL:?DATABASE_URL is required}` contract.
- **Migrations:** run via a **Coolify pre-deployment command** invoking
  `bun run db:migrate` against the standalone Postgres. A failed migration
  aborts the rollout before new `web`/`worker` containers are exposed —
  deploys are atomic with schema changes. The `migrate` service in
  `docker-compose.prod.yml` stays defined as a **manual escape hatch** but
  is not the normal path.
- **Local development is unchanged.** `docker-compose.yml` keeps its
  in-compose `postgres` service. Dev/prod parity is at the application
  layer (`web`, `worker`) and the Postgres major version, not at the
  question of who manages the DB container.
- **Resilience:** `web` and `worker` get `restart: unless-stopped`. The
  worker's existing reconnect-and-rescan loop in
  `worker/src/slusko_worker/queue_loop.py` handles Postgres restarts
  cleanly — any exception drops the LISTEN connection, backs off, opens a
  fresh connection, re-runs `register_listener`, and re-runs the
  scan-on-boot. ADR 0004's resilience design is sufficient; no new
  connection-retry framework is introduced and no `pg_isready` wrapper is
  needed on the migrate runner.

## Consequences

- **ADR 0004's enumeration of compose services narrows in prod.** The
  `postgres` Compose service and the `postgres_data` volume are removed
  from `docker-compose.prod.yml`. ADR 0004's queue semantics
  (`LISTEN/NOTIFY`, `SELECT … FOR UPDATE SKIP LOCKED`, scan-on-boot,
  serialized single-worker processing) are unchanged.
- **ADR 0001's "same Compose file local and prod" weakens slightly.** The
  same *application* compose runs in both worlds; the DB lifecycle owner
  differs. ADR 0001's "centralized on infra we control" stance is
  preserved — the Coolify host is still infra we control.
- **ADR 0010 is unchanged on schema ownership.** Drizzle still owns the
  schema in `web/app/db/schema.ts` with migrations in
  `web/app/db/migrations/`. The *execution mechanism* moves from "manual
  `docker compose run --rm migrate` post-deploy" to "Coolify pre-deploy
  command", and deploys become atomic with migrations.
- **Postgres credentials no longer appear in `docker-compose.prod.yml`.**
  `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` are properties of
  the Coolify Postgres resource. Only `DATABASE_URL` is consumed by the
  app stack.
- **Backups are explicitly deferred.** They will be configured on the
  Coolify Postgres resource (daily local `pg_dump`, short retention)
  immediately after the production cutover. Audio files in
  `slusko_meetings` are out of scope for DB backups; a restore against a
  divergent audio volume may surface dangling rows, which the worker can
  surface as `error` per ADR 0007. A combined snapshot strategy is a
  follow-up when Slusko moves toward public-domain deployment per
  ADR 0001's Phase 2.
- **Reversal cost is meaningful.** Moving back to in-compose Postgres
  after backups, env wiring, and Coolify pre-deploy commands are
  configured costs hours, not minutes. Worth revisiting only if Coolify's
  standalone Postgres becomes a problem in practice.
- **Out-of-scope follow-ups:** offsite/S3 backups (likely required at the
  Phase 2 public-domain transition); worker-side connection-retry
  hardening beyond `restart: unless-stopped` (only if the existing
  reconnect loop proves insufficient under real load).
