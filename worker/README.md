# Slusko Worker

Python worker for Slusko's Postgres-backed meeting pipeline.

## v1 access boundary

This project is designed for VPN-only/self-hosted use in v1.

- No in-app auth is provided in this release.
- Do **not** expose the stack publicly without future auth work.

## What the worker does

- Validates required startup config before queue processing
- Validates DB connectivity at startup (`SELECT 1`)
- Listens for queue notifications and drains pending work
- Runs normalization, transcription, diarization, and summarization stages

## Required environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `HF_TOKEN` or `HUGGINGFACE_TOKEN` | Hugging Face auth for gated model access |
| `WHISPER_MODEL` | Whisper model id/name used by transcription |
| `PYANNOTE_MODEL` | pyannote pipeline id/name used by diarization |
| `OPENROUTER_API_KEY` | OpenRouter API key for summarization |
| `OPENROUTER_MODEL` | OpenRouter model id |
| `MODEL_CACHE_DIR` | Persistent model cache directory |
| `HF_HOME` | Hugging Face cache root |

Optional:

- `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`)
- `OPENROUTER_TIMEOUT_SECONDS` (default `120`)
- Queue/database tuning knobs (`QUEUE_POLL_INTERVAL_SECONDS`, keepalive/connect timeout envs)

## Model cache + preload

Compose mounts a persistent model cache volume:

- `slusko_models` mounted at `/data/models`
- Typical defaults: `MODEL_CACHE_DIR=/data/models`, `HF_HOME=/data/models`

Preload models outside queue processing.

Recommended (Compose, consistent with root README):

```bash
docker compose run --rm worker slusko-worker-preload-models
```

Local (without Compose): first copy repo-root `.env.example` to `.env` and fill real values for all required worker variables (`DATABASE_URL`, HF token, model ids, OpenRouter key/model, cache paths), then run:

```bash
cd worker
set -a
source ../.env
set +a
slusko-worker-preload-models
```

`slusko-worker-preload-models` uses the same startup validation as the worker and preloads Whisper + pyannote into the persistent cache. If skipped, first runtime processing may lazily download models into the same persistent cache.

## Artifact persistence

Compose named volumes:

- `slusko_meetings` at `/data/meetings` for uploaded/normalized audio artifacts
- `slusko_models` at `/data/models` for model weights/cache

Avoid `docker compose down -v` unless you intentionally want to delete both uploaded audio artifacts and model weights/cache.

## Local run (without Compose)

```bash
cd worker
python -m venv .venv
source .venv/bin/activate
pip install .

# from repo root: cp .env.example .env and fill real required values
set -a
source ../.env
set +a

slusko-worker
```

## Tests

```bash
cd worker
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
```
