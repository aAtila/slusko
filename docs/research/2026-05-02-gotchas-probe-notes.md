# Research notes — gotchas probe batch 1

**Date:** 2026-05-02

These notes preserve the fuller findings from the first research-agent pass.
`docs/gotchas.md` should stay the distilled, implementation-facing checklist;
this file keeps the source-heavy detail and links for later verification.

## Completed probes

- Postgres-as-queue with `LISTEN` / `NOTIFY` and `FOR UPDATE SKIP LOCKED`.
- faster-whisper + pyannote.audio deployment in Docker.
- React Router v7 streamed multipart uploads for 1 GB files.
- OpenRouter structured JSON / provider caveats from Python.

## Probes to rerun

This timed out twice during external-doc lookup and should be rerun later with
an even narrower prompt or handled manually:

- Docker named volume backup/restore + UID/GID strategy.

---

## Postgres-as-queue notes

### Findings worth carrying forward

- Use a **dedicated listener connection**, separate from the normal connection
  pool.
- The listener connection should use `autocommit=True`; otherwise notification
  delivery can be delayed by transaction boundaries.
- Register `LISTEN meetings_pending` **before** the startup/resume scan to
  avoid a race where a job is inserted between the scan and the listener being
  active.
- Insert the Meeting row and send the notification in the **same transaction**.
  `NOTIFY` is delivered only on commit, which is exactly what we want.
- Keep notification payloads tiny. Postgres `NOTIFY` payloads are capped at
  8000 bytes; send only a Meeting UUID, or ignore the payload and just claim
  the next row.
- Use TCP keepalives and a periodic polling fallback. Treat `LISTEN/NOTIFY` as
  a latency optimization, not the only correctness mechanism.
- Do not hold a database transaction open for the duration of a transcription
  job. Claim quickly, release, do CPU/GPU work outside the transaction, then
  write stage outputs in short transactions.
- Add a partial index matching the queue/resume predicate so completed meetings
  do not slow down worker claims.

### Suggested worker-loop shape

```python
listen_conn = psycopg.connect(
    dsn,
    autocommit=True,
    keepalives=1,
    keepalives_idle=60,
    keepalives_interval=10,
    keepalives_count=5,
)
listen_conn.execute("LISTEN meetings_pending")

# Important: scan after LISTEN is active.
process_pending_and_resumable_jobs(pool)

while True:
    try:
        for notify in listen_conn.notifies(timeout=300):
            claim_and_process_one_job(pool)

        # Timeout path: recover missed notifications / stalled jobs.
        process_pending_and_resumable_jobs(pool)
    except Exception:
        logger.exception("listener failed; reconnecting")
        time.sleep(5)
        listen_conn = reconnect_listener(dsn)
```

### Sources

- PostgreSQL `LISTEN`: https://www.postgresql.org/docs/current/sql-listen.html
- PostgreSQL `NOTIFY`: https://www.postgresql.org/docs/current/sql-notify.html
- psycopg3 async / notifications docs: https://www.psycopg.org/psycopg3/docs/advanced/async.html
- CYBERTEC — TCP keepalive for PostgreSQL: https://www.cybertec-postgresql.com/en/tcp-keepalive-for-a-better-postgresql-experience/
- Instacart — PostgreSQL TCP connection parameters: https://tech.instacart.com/the-vanishing-thread-and-postgresql-tcp-connection-parameters-93afc0e1208c/
- Netdata — queue workflows with `SKIP LOCKED`: https://www.netdata.cloud/academy/update-skip-locked/
- Inferable — `SKIP LOCKED` patterns: https://www.inferable.ai/blog/posts/postgres-skip-locked

---

## faster-whisper + pyannote notes

### Findings worth carrying forward

- `pyannote/speaker-diarization-3.1` effectively requires access to two gated
  HuggingFace repos:
  - `pyannote/speaker-diarization-3.1`
  - `pyannote/segmentation-3.0`
- Prefer `token=` in `Pipeline.from_pretrained(...)`; older docs may still show
  `use_auth_token=`.
- Set `HF_HOME=/data/models` or similar so HuggingFace cache state survives
  container recreation and is shared by pyannote-related downloads.
- Avoid baking private HuggingFace tokens into Docker build layers. Prefer a
  runtime/init pre-download step into a persistent model volume.
- After pre-populating the model cache, `HF_HUB_OFFLINE=1` can turn missing
  weights into a startup failure instead of a surprise multi-GB job-time
  download.
- If a failed download leaves weird auth/cache behavior, clear the HF cache;
  stale `.no_exist` markers can make a valid token look broken.
- `faster_whisper.WhisperModel(...).transcribe(...)` returns a one-shot lazy
  generator. Iterate once and collect/update progress in that same loop.
- Whisper timestamps and pyannote speaker turns do not align exactly. Use
  overlap voting or midpoint lookup instead of exact boundary matching.
- GPU support is version-sensitive:
  - pin CTranslate2;
  - use CUDA images with cuDNN runtime;
  - install CUDA Torch/Torchaudio before `pyannote.audio`;
  - choose explicit compute types (`int8` on CPU, `float16` on modern CUDA).

### Suggested startup shape

```python
# Pseudocode only.
validate_hf_token_can_access(
    "pyannote/segmentation-3.0",
    "pyannote/speaker-diarization-3.1",
)

ensure_model_cache_populated_before_claiming_jobs()

whisper_model = WhisperModel(
    os.environ.get("WHISPER_MODEL", "large-v3"),
    device=os.environ.get("WHISPER_DEVICE", "auto"),
    compute_type=selected_compute_type,
)

diarization_pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-3.1",
    token=os.environ["HF_TOKEN"],
)
```

### Sources

- pyannote speaker diarization model card: https://huggingface.co/pyannote/speaker-diarization-3.1
- pyannote segmentation model card: https://huggingface.co/pyannote/segmentation-3.0
- faster-whisper repository: https://github.com/SYSTRAN/faster-whisper
- CTranslate2 installation docs: https://opennmt.net/CTranslate2/installation.html
- faster-whisper issue — CUDA/cuDNN compatibility: https://github.com/SYSTRAN/faster-whisper/issues/1086
- faster-whisper issue — `libcublas.so.12` failures: https://github.com/SYSTRAN/faster-whisper/issues/717
- faster-whisper issue — Docker image selection: https://github.com/SYSTRAN/faster-whisper/issues/998
- faster-whisper issue — `download_root` cache quirk: https://github.com/SYSTRAN/faster-whisper/issues/181
- pyannote issue — pip resolving CPU Torch: https://github.com/pyannote/pyannote-audio/issues/1675
- HuggingFace Hub cache docs: https://huggingface.co/docs/huggingface_hub/en/guides/manage-cache
- HuggingFace offline mode docs: https://huggingface.co/docs/transformers/installation

---

## React Router v7 upload notes

### Findings worth carrying forward

- `request.formData()` buffers the full body and must not be used for 1 GB
  recording uploads.
- React Router v7 removed older Remix multipart helpers; use a current streaming
  parser such as `@mjackson/form-data-parser` in actions, or Busboy if handling
  raw Node requests yourself.
- Watch for examples that call `fileUpload.bytes`; that re-materializes the
  upload in memory. Pipe `fileUpload.stream()` directly to disk.
- Check `Content-Length` before consuming the body for fast rejection, but keep
  parser-level max-size enforcement because clients can lie.
- Write uploads to a partial/temp path and clean it up on abort, stream error,
  or incomplete close.
- React Router actions do not provide live upload progress by default. For v1,
  prefer an indeterminate spinner; exact progress needs a side channel.

### Sources

- React Router file uploads how-to: https://reactrouter.com/how-to/file-uploads
- `@mjackson/form-data-parser`: https://github.com/mjackson/remix-the-web/tree/main/packages/form-data-parser
- `@mjackson/multipart-parser`: https://github.com/mjackson/multipart-parser
- React Router / Remix upload helper discussion: https://github.com/remix-run/remix/discussions/10268
- React Router abort signal issue: https://github.com/remix-run/react-router/issues/14817
- Busboy: https://github.com/mscdex/busboy

---

## OpenRouter structured-output notes

### Findings worth carrying forward

- The Python OpenAI SDK can talk to OpenRouter by setting
  `base_url="https://openrouter.ai/api/v1"` and using
  `OPENROUTER_API_KEY` as the API key.
- `HTTP-Referer` and `X-Title` headers are optional attribution/dashboard
  metadata, not auth.
- Use `json_schema`, not `json_object`, for strict Summary output shape.
- Include `provider.require_parameters = true` so OpenRouter excludes routes
  that cannot honor required params instead of silently dropping structured
  output guarantees.
- Consider the OpenRouter `response-healing` plugin for non-streaming summary
  calls; it can repair simple JSON syntax but not truncated output.
- Avoid regex `pattern` constraints in Pydantic schemas for the Summary output;
  some model routes reject them.
- Treat `402` insufficient credits as configuration/billing, not a transient
  retryable worker error. `429`, `502`, and `503` need bounded retry/backoff
  rules.
- Failed provider calls can still cost prompt tokens.
- No reliable public benchmark was found for Serbian/code-switched meeting
  summarization across the candidate models; keep the planned local A/B test.

### Sources

- OpenRouter quickstart: https://openrouter.ai/docs/quickstart
- OpenRouter app attribution: https://openrouter.ai/docs/app-attribution
- OpenRouter structured outputs: https://openrouter.ai/docs/guides/features/structured-outputs
- OpenRouter response healing: https://openrouter.ai/docs/guides/features/plugins/response-healing
- OpenRouter errors/debugging: https://openrouter.ai/docs/api-reference/errors
- OpenRouter rate limits: https://openrouter.ai/docs/api-reference/limits
- OpenRouter model fallbacks: https://openrouter.ai/docs/guides/routing/model-fallbacks
- Instructor OpenRouter integration: https://python.useinstructor.com/integrations/openrouter/
