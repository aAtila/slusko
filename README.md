# Slusko

Compose-first local stack for Slusko (`postgres`, `web`, `worker`).

## Prerequisites

- Docker + Docker Compose v2
- Bun 1.3.9 (for local `web/` commands outside containers)

## Start the stack

From repo root:

```bash
# 1) Start database
docker compose up -d postgres

# 2) Apply Drizzle migrations from the web service image
docker compose run --rm web bun run db:migrate

# Optional: add sample local-development meetings
docker compose run --rm web bun run db:seed

# 3) Start app services
docker compose up web worker
```

Web app: http://localhost:5173

## Production deployment with Compose/Coolify

Use `docker-compose.prod.yml` for production-style deployments. Unlike the local-dev `docker-compose.yml`, it builds the web `production` target, does not bind-mount `./web`, and lets `web/Dockerfile` run `bun run start`. It also includes a one-shot `migrate` service for Drizzle migrations.

Required production environment variables:

- `POSTGRES_PASSWORD`
- `DATABASE_URL` (for the bundled Postgres service, use `postgres://<user>:<password>@postgres:5432/<db>`)
- `HF_TOKEN` if diarization needs Hugging Face access

One-time/per-deploy migration step:

```bash
docker compose -f docker-compose.prod.yml run --rm migrate
```

Then start the production stack:

```bash
docker compose -f docker-compose.prod.yml up -d
```

For Coolify, configure the resource as Docker Compose and point the compose file path to `docker-compose.prod.yml`.

## Stop the stack

```bash
docker compose down
```

Do **not** run `docker compose down -v` unless you intentionally want to delete named volumes: local Postgres data (`postgres_data`), uploaded meetings (`slusko_meetings`), and model cache (`slusko_models`).

## Worker runtime notes (issue #7 slice)

- The worker image installs `ffmpeg`, which also provides `ffprobe` required by normalization.
- Compose sets worker runtime paths explicitly:
  - `MEETINGS_DIR=/data/meetings`
  - `MODEL_CACHE_DIR=/data/models`
  - `HF_HOME=/data/models`
- This is a normalization-only vertical slice: worker marks meetings `done` after successful normalization + duration capture; downstream transcription/diarization/summarization are future work.

## Issue #7 acceptance QA

Use a disposable local/dev database or back up anything you need before forcing failures.

### Happy path: upload to normalized audio

1. Start Postgres and apply migrations:

   ```bash
   docker compose up -d postgres
   docker compose run --rm web bun run db:migrate
   ```

2. Start the app services:

   ```bash
   docker compose up web worker
   ```

3. In the web UI at http://localhost:5173, upload a small `.mp3`, `.m4a`, `.wav`, or `.mp4`.
4. Verify the meeting appears as `pending` / “Queued”, then transitions to `normalizing` / “Normalizing audio”.
5. After the worker finishes, verify:
   - `/data/meetings/<meeting_uuid>/normalized.wav` exists in the shared meeting volume, for example with `docker compose exec worker test -f /data/meetings/<meeting_uuid>/normalized.wav`;
   - the original `original.<ext>` file is removed, for example with `docker compose exec worker sh -c 'ls -la /data/meetings/<meeting_uuid>'`;
   - `meetings.duration_seconds` is a non-null integer;
   - `meetings.status` is `done` for this normalization-only slice;
   - the home list stops polling and shows the duration + “Done”;
   - `/meetings/<meeting_uuid>` shows the same duration and status.

### Failure behavior

1. Create or upload a meeting, then force a normalization failure before the worker processes it, for example by replacing the uploaded `original.<ext>` with corrupt bytes or removing the original file from `/data/meetings/<meeting_uuid>/`.
2. Start or let the worker drain the queue.
3. Verify the row is terminal `error` with `error_kind`, actionable `error_message`, and `failed_at_stage='normalizing'`.
4. Verify the home list shows the failed state and `/meetings/<meeting_uuid>` shows the failure details.

### Missed notification recovery

1. Stop the worker.
2. Insert or upload a meeting so a row exists with `status='pending'` while no worker is listening.
3. Start the worker.
4. Verify the worker registers `LISTEN meetings_pending` before its startup scan, then processes the pending row through normalization to `done`.

### Polling fallback

1. Start the worker with a short fallback interval for QA, for example `QUEUE_POLL_INTERVAL_SECONDS=5`.
2. Insert a valid pending row and matching `/data/meetings/<meeting_uuid>/original.<ext>` without sending `NOTIFY meetings_pending`.
3. Verify the worker picks it up on the fallback poll interval and follows the same pending → normalizing → `normalized.wav` + `duration_seconds` → `done` path.
