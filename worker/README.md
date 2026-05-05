# Slusko Worker

Python worker for Slusko's Postgres-backed meeting pipeline.

## Scope right now

The worker currently implements the queue-runner foundation plus the first real pipeline stage: audio normalization.

- Validates DB connectivity at startup (`SELECT 1`)
- Opens a dedicated autocommit listener connection
- Registers `LISTEN meetings_pending` before scanning for existing work
- Claims non-terminal meetings with `SELECT ... FOR UPDATE SKIP LOCKED`
- Processes claimed meetings serially
- Falls back to polling with `QUEUE_POLL_INTERVAL_SECONDS` when no notification arrives
- Handles SIGTERM/SIGINT at queue-loop boundaries
- Processes `pending` and recovered `normalizing` meetings through normalization
- Normalizes one uploaded original file from `${MEETINGS_DIR}/<meeting_uuid>/original.<ext>` where `<ext>` is `.mp3`, `.m4a`, `.wav`, or `.mp4`
- Runs the canonical normalization command:
  `ffmpeg -i <input> -vn -ac 1 -ar 16000 -c:a pcm_s16le -y <output>`
- Removes stale `normalized.wav.partial`, writes a transient WAV with the canonical ffmpeg args, atomically promotes it through `normalized.wav.partial` to `normalized.wav`, then deletes original files
- Captures integer `duration_seconds` via `ffprobe` and marks the row `done`

This is intentionally a normalization-only vertical slice. `done` means the worker successfully normalized audio and recorded duration; transcript, diarization, and summary fields remain empty until later pipeline stages are implemented.

## Recovery behavior

Claimed `pending` and `normalizing` meetings re-enter normalization idempotently. Claimed later-stage meetings (`transcribing`, `diarizing`, `summarizing`) are still moved to a terminal `error` state with `error_kind='unknown'` and a message explaining that recovery beyond normalization is not implemented in this slice. This avoids endless reclaims while keeping startup recovery safe.

## Schema ownership

- Canonical schema + migrations: `web/app/db/schema.ts` and `web/app/db/migrations`
- Worker mirrors only narrow queue/pipeline fields in `src/slusko_worker/db/models.py`

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres connection string |
| `MEETINGS_DIR` | `/data/meetings` | Shared meeting artifacts directory |
| `MODEL_CACHE_DIR` | `/data/models` | Future model cache directory |
| `HF_HOME` | `MODEL_CACHE_DIR` value | Hugging Face cache root; defaults to `MODEL_CACHE_DIR` when unset |
| `QUEUE_POLL_INTERVAL_SECONDS` | `300` | Polling fallback interval for missed notifications |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `5` | libpq connect timeout |
| `DATABASE_TCP_KEEPALIVES` | `1` | Enable TCP keepalives for the listener connection |
| `DATABASE_TCP_KEEPALIVES_IDLE` | `60` | TCP keepalive idle seconds |
| `DATABASE_TCP_KEEPALIVES_INTERVAL` | `30` | TCP keepalive interval seconds |
| `DATABASE_TCP_KEEPALIVES_COUNT` | `5` | TCP keepalive probe count |

## Docker/Compose runtime notes

- Worker image requires `ffmpeg` (and bundled `ffprobe`) for normalization.
- Compose keeps meeting artifacts and model cache on named volumes:
  - `slusko_meetings` mounted at `/data/meetings` (shared between web + worker)
  - `slusko_models` mounted at `/data/models` (worker model cache)
- Current Compose setup keeps both web and worker running as container root in local dev so shared-volume ownership stays aligned.
- Avoid `docker compose down -v` unless you intentionally want to delete uploaded originals/normalized artifacts and model cache.

## Local run (without Compose)

```bash
cd worker
python -m venv .venv
source .venv/bin/activate
pip install .
DATABASE_URL=postgres://slusko:slusko@localhost:5432/slusko slusko-worker
```

## Tests

```bash
cd worker
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
```

To run the real Postgres `SKIP LOCKED` concurrency check, provide a test database URL:

```bash
WORKER_TEST_DATABASE_URL=postgres://slusko:slusko@localhost:5432/slusko pytest
```
