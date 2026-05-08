# Slusko

Compose-first self-hosted stack for Slusko (`postgres`, `web`, `worker`).

## v1 access boundary (important)

Slusko v1 is intended for VPN-only/self-hosted environments.

- There is no in-app auth in v1.
- Do **not** expose this stack publicly on the internet until dedicated auth work lands in a future issue.

## Prerequisites

- Docker + Docker Compose v2
- Bun 1.3.9 (for local `web/` commands outside containers)

## Required worker environment

The worker now validates required startup config before queue processing. Required values:

- `DATABASE_URL`
- `HF_TOKEN` **or** `HUGGINGFACE_TOKEN`
- `WHISPER_MODEL`
- `PYANNOTE_MODEL`
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `MODEL_CACHE_DIR`
- `HF_HOME`

`OPENROUTER_BASE_URL` and `OPENROUTER_TIMEOUT_SECONDS` are optional overrides.

Use `.env.example` as the baseline.

## Start the local stack

From repo root:

```bash
# 1) Start database
docker compose up -d postgres

# 2) Apply Drizzle migrations
docker compose run --rm web bun run db:migrate

# Optional: add sample meetings
docker compose run --rm web bun run db:seed

# 3) Start app services
docker compose up web worker
```

Web app: http://localhost:5173

## Model preload command (recommended)

To preload Whisper + pyannote into the persistent model cache **outside** meeting processing:

```bash
docker compose run --rm worker slusko-worker-preload-models
```

This command uses the same startup validation as the normal worker process. If you skip preload, the first real meeting processing run may lazily download models into the same persistent cache volume.

## Named volumes and persistence

- `slusko_meetings`: uploaded originals + normalized audio artifacts.
- `slusko_models`: model weights/cache used by Whisper + pyannote.

Stop normally with:

```bash
docker compose down
```

⚠️ `docker compose down -v` deletes **both** `slusko_meetings` and `slusko_models`.

## Production deployment with Compose/Coolify

Use `docker-compose.prod.yml` for production-style deployments. It builds the web `production` target, avoids bind-mounting `./web`, and runs the production web server.

Production Postgres is a standalone Coolify-managed database resource (same host/network scope).

Required production env:

- `DATABASE_URL`
- `HF_TOKEN` or `HUGGINGFACE_TOKEN`
- `WHISPER_MODEL`
- `PYANNOTE_MODEL`
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `MODEL_CACHE_DIR` (defaults to `/data/models` in compose)
- `HF_HOME` (defaults to `/data/models` in compose)

Optional:

- `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`)
- `OPENROUTER_TIMEOUT_SECONDS` (default `120`)

Deploy flow in Coolify:

1. Configure pre-deploy migration command to run `bun run db:migrate` with the same `DATABASE_URL`.
2. Keep `docker-compose.prod.yml` as the app stack definition for `web` and `worker`.

If migrations fail, Coolify aborts rollout before exposing new containers.

The `migrate` service in `docker-compose.prod.yml` remains a manual escape hatch for ad-hoc migration operations.
