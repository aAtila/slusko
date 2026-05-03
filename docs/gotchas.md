# Implementation gotchas

Things that bit us in the design conversation, or that I know from
experience will bite during implementation. **Read this before writing
code in the affected area.**

This is a living document — append new entries as they're discovered.
Each gotcha names the area it affects, what the trap is, and the
short version of the fix.

---

## Worker — Whisper / faster-whisper

### "Thank you" hallucination on near-silent audio

faster-whisper, like the original Whisper, will sometimes emit
`"Thank you."` (or `"Hvala."`) for stretches of silence or background
music. The Q19 heuristic in
[ADR 0007](./adr/0007-pipeline-status-and-failure-semantics.md)
catches the worst case. If you still see hallucinations on
actual-speech audio, set:

```python
WhisperModel(...).transcribe(..., condition_on_previous_text=False)
```

This trades a small amount of context-quality for much better behavior
on quiet audio. Worth it.

### Model weights are large and cold-downloaded by default

`large-v3` weights are ~3 GB; pyannote's diarization pipeline is
another ~1 GB. By default they download on first use — meaning the
**first-ever upload doubles as the first-ever download** and looks
catastrophically slow.

Fix: keep model weights in a persistent model volume and pre-populate
it before the worker starts claiming jobs. Set `HF_HOME` to that
volume so both pyannote and HuggingFace-backed downloads use the same
persistent cache. Avoid baking private HuggingFace tokens into Docker
build layers.

After the model volume is populated, consider setting `HF_HUB_OFFLINE=1`
at runtime. Then a missing model fails at startup instead of silently
starting a multi-GB download during a real meeting job.

If a download fails halfway, HuggingFace Hub can leave stale cache
metadata such as `.no_exist` markers. If access looks correct but the
model still will not load, clear the model cache and re-run the
pre-download step rather than chasing phantom auth bugs.

### Pyannote requires a HuggingFace token + two license acceptances

`pyannote/speaker-diarization-3.1` is gated, and it depends on a
second gated model: `pyannote/segmentation-3.0`. To use diarization
you must:

1. Create a HuggingFace account.
2. Accept the terms for **both** `pyannote/speaker-diarization-3.1`
   and `pyannote/segmentation-3.0`.
3. Generate a token at `huggingface.co/settings/tokens`.
4. Pass the token as `HF_TOKEN` env to the worker container.

Missing access to the segmentation model can show up as a cryptic 401
at pipeline load time. Startup should validate access to both repos
and fail fast with `errorKind: 'config_missing'` and a message that
names the exact HuggingFace fix.

When loading the pipeline, prefer the current `token=` argument over
older snippets that use `use_auth_token=`:

```python
Pipeline.from_pretrained(
    "pyannote/speaker-diarization-3.1",
    token=os.environ["HF_TOKEN"],
)
```

### Pyannote pipeline load is slow — keep it warm

Loading the pyannote 3.x diarization pipeline takes ~10–30 s on a
cold run. **Load it once at worker startup**, not per-meeting. The
single-worker model in
[ADR 0004](./adr/0004-postgres-as-queue-single-worker.md)
makes this trivial — store the loaded pipeline as a module-level
variable.

### `transcriptionProgress` updates need throttling

faster-whisper yields per-segment generation, so you can compute a
percentage as you go. **Do not update the database on every segment**
— that's hundreds of UPDATEs for a 1-hour meeting. Update at most
every ~5 seconds (or every N segments, whichever is rougher).

### Apple Silicon dev machines have a CTranslate2 footgun

faster-whisper uses CTranslate2 under the hood. The default
`pip install ctranslate2` on macOS gives you a CPU-only build —
**no Metal acceleration**. Local dev runs will be slow.

You can either accept the slow dev loop, or build CTranslate2 from
source with Metal support. The former is fine for design-time
testing; the latter is worth it if you're iterating on the worker.

### `transcribe()` returns a one-shot generator

In faster-whisper, `model.transcribe(...)` returns `(segments, info)`,
where `segments` is a lazy generator. The actual transcription work
happens as you iterate it, and the generator is consumed once.

Do not call `list(segments)` for counting/progress and then expect to
iterate it again for database writes. Use one manual loop that collects
segments, updates throttled progress, and stores whatever metadata the
next stage needs.

### Diarization and transcription timestamps will not align exactly

Whisper segment boundaries and pyannote speaker turns are computed
independently. Do not expect exact boundary matches.

For v1, assign speakers by either:

- **overlap voting** — choose the speaker interval with the largest
  overlap with a Whisper segment, or
- **midpoint lookup** — choose the speaker active at the segment or word
  midpoint.

Overlap voting is more robust for short back-and-forth. Midpoint lookup
is simpler but can misassign boundary words. Either way, build a sorted
list of pyannote `(start, end, speaker)` intervals once and avoid
quadratic scans over long meetings.

### CTranslate2, CUDA, and Torch versions are a three-way trap

GPU acceleration depends on compatible versions of NVIDIA drivers,
CUDA/cuDNN, CTranslate2, and Torch. A mismatch usually fails as
`libcublas.so.* not found`, a cuDNN complaint, or `torch.cuda.is_available()`
being false — not as a friendly "wrong version matrix" error.

Rules of thumb:

- Pin `ctranslate2` instead of floating to latest.
- For CUDA images, use an NVIDIA image with **cuDNN runtime**, not plain
  `runtime` or `base`.
- Install CUDA-enabled `torch` / `torchaudio` from the PyTorch CUDA index
  before installing `pyannote.audio`; otherwise pip may resolve a CPU-only
  Torch build and silently kill GPU support.
- Keep `compute_type` explicit: CPU usually wants `int8`; modern CUDA
  usually wants `float16`.

---

## Worker — OpenRouter / LLM

### Default model selection is not yet decided

[ADR 0002](./adr/0002-cloud-llm-via-openrouter-for-summarization.md)
deliberately leaves `OPENROUTER_MODEL` undefined. **Plan an evening
to A/B Serbian summary quality** across at least
`anthropic/claude-sonnet-4`, `openai/gpt-4o`, and
`google/gemini-2.5-pro` against a real Serbian transcript. Ship the
winner as the default and document it in CONTEXT.md.

### LLM responses are sometimes malformed JSON

Even frontier models occasionally return invalid JSON, truncated
output, or a Summary that doesn't conform to our schema. **Validate
the response with Pydantic and treat a validation failure as a
retryable error** (per the auto-retry rules in
[ADR 0007](./adr/0007-pipeline-status-and-failure-semantics.md)).
Do not silently accept a half-summary.

Prefer `json_schema` structured outputs over `json_object` and consider
using Instructor around the OpenAI-compatible client so Pydantic
validation failures automatically participate in a retry loop.

### OpenRouter routing can silently drop structured-output guarantees

Not every OpenRouter model/provider route supports every parameter. If
you request structured output and OpenRouter routes to a provider that
ignores the parameter, you can get prose back instead of JSON.

Fix: include `provider.require_parameters = true` in the OpenRouter
request body so routes that cannot honor required parameters are
excluded instead of silently degrading.

Be careful with fallback model arrays: every fallback model must also
support `json_schema`, or `require_parameters` may exclude it from the
fallback chain.

### Keep the Summary schema boring

Some providers reject parts of JSON Schema that others accept. In
particular, regex-style `pattern` constraints in Pydantic-generated
schemas can break OpenAI model routes.

For the Summary response, avoid clever schema constraints unless they
are essential. Keep shape validation in Pydantic, and enforce semantic
rules in application code after parsing.

### OpenRouter response healing helps syntax, not truncation

OpenRouter's `response-healing` plugin can repair simple JSON syntax
problems such as code fences, trailing commas, or missing brackets. It
is a useful extra guard for non-streaming summary calls.

It cannot fix a response truncated by `max_tokens`. Set `max_tokens`
generously for summaries and still validate with Pydantic.

### OpenRouter passes errors through; don't assume HTTP 200 means good

OpenRouter relays the upstream provider's response. A successful
HTTP 200 response can still contain `error` content if the upstream
provider had an issue. Always parse the JSON and check for an
`error` field before treating the result as a summary.

Also expect provider-shaped failures: `402` for insufficient credits,
`429` for rate limits, `502` for upstream provider problems, and `503`
when routing constraints cannot be satisfied. Do not retry `402` as a
transient worker failure; surface it as configuration/billing action.

### Failed OpenRouter calls can still cost money

An upstream provider can process prompt tokens and then fail with a 5xx
or empty response. Budget for a small amount of wasted spend and avoid
aggressive retry loops, especially on rate-limit or provider-error
storms.

### OpenRouter cold starts can look like hangs

Some model/provider routes have cold-start latency. The first summary
call can take much longer than steady state, occasionally long enough
to hit a too-small client timeout.

Use a realistic timeout for summarization calls, then rely on bounded
retries with exponential backoff. Do not leave the HTTP client on an
unbounded default timeout.

---

## Worker — Pipeline state machine

### Stage entry must be delete-then-insert, not "skip if exists"

[ADR 0007](./adr/0007-pipeline-status-and-failure-semantics.md)
requires idempotent stage re-entry. The cheap, correct convention
is: at the start of each stage, **delete that stage's outputs for
the current Meeting**, then re-run the stage from scratch. Example:
on entering `transcribing`, run
`DELETE FROM segments WHERE meeting_id = $1` first.

A "skip if exists" check sounds cheaper but is wrong — a half-
written previous run can leave inconsistent rows that pass the check
but are corrupt.

### `SELECT FOR UPDATE SKIP LOCKED` requires an explicit transaction

In `psycopg`, autocommit mode means no row-level lock is held. The
worker's claim step must explicitly open a transaction:

```python
with conn.transaction():
    row = conn.execute(
        "SELECT id FROM meetings WHERE status = 'pending' "
        "ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1"
    ).fetchone()
    # ... mark as 'normalizing' inside the same transaction
```

Without the transaction, two workers (when we eventually scale out)
would both grab the same row.

### LISTEN/NOTIFY needs a dedicated connection, not a pooled one

Postgres's `LISTEN` state is bound to a connection. If the worker
gets connections from a pool, the listener may end up on a connection
that gets returned to the pool, dropping the subscription.

Use a **dedicated long-lived connection** for the listener. Job
processing (claim + writes) can use the pool normally.

### The LISTEN connection should be autocommit

In psycopg, notifications can be delayed by transaction boundaries.
For the dedicated listener, connect with `autocommit=True`, issue
`LISTEN meetings_pending`, and keep job-claiming writes on separate
pooled connections with explicit transactions.

Also prefer `SELECT pg_notify($1, $2)` over constructing raw `NOTIFY`
strings when sending from application code; it keeps channel/payload
handling parameterized.

### Register LISTEN before the startup scan

Startup ordering matters. If the worker scans for `pending` jobs first
and only then starts listening, a job inserted in the gap can be missed
until the next polling fallback or restart.

Correct sequence:

1. Open the dedicated listener connection.
2. Register `LISTEN meetings_pending`.
3. Scan for existing `pending` / resumable rows.
4. Enter the notification loop.

### NOTIFY is transactional and payloads are tiny

Postgres delivers `NOTIFY` only when the surrounding transaction
commits. This is good: insert the Meeting row and notify in the same
transaction so the worker is only woken for committed jobs.

The payload limit is 8000 bytes, so never send job data in the
notification. Send only the Meeting UUID — or even ignore the payload
entirely — and have the worker claim the next row with
`FOR UPDATE SKIP LOCKED`.

### Listener connections need keepalives and a polling fallback

A Docker network, firewall, or host TCP stack can silently drop an idle
LISTEN connection. Configure libpq TCP keepalives for the dedicated
listener and add a periodic timeout/poll fallback that re-scans for
`pending` and resumable jobs.

This also recovers from missed notifications and makes LISTEN/NOTIFY a
latency optimization rather than the only correctness mechanism.

### Long worker jobs must not hold long database transactions

A 1-hour transcription must not sit inside one open transaction. Long
transactions interfere with vacuum, locks, and Postgres notification
queue cleanup.

Keep transactions short: claim a job in one transaction, release the
lock, run CPU/GPU work outside the DB transaction, then write stage
outputs/status in short transactions at stage boundaries.

### Add a tiny partial index for in-flight jobs

The queue query should not scan a growing pile of completed meetings.
Add a partial index covering only queue-relevant rows, for example:

```sql
CREATE INDEX idx_meetings_in_flight
  ON meetings (created_at ASC)
  WHERE status IN (
    'pending',
    'normalizing',
    'transcribing',
    'diarizing',
    'summarizing'
  );
```

The exact predicate should match the worker's startup/resume query.

---

## Database / Drizzle

### JSONB columns in Drizzle: parsed on read, object on write

Drizzle's `jsonb()` column type:

- **Reads** return parsed JS objects (good, ergonomic).
- **Writes** must be passed as objects, not pre-stringified.

Easy to mix up after writing raw SQL elsewhere. If you find yourself
double-encoded JSON in the DB (`"\"{\\\"key\\\":...\""`), this is
why.

### Migrations are SQL files — review them before applying

Drizzle Kit generates SQL migrations from schema diffs. They are
mostly correct, but renames are often expressed as drop-then-add
(which loses data). Always read the generated SQL before running
migrate, especially on shared environments.

---

## Web app — uploads

### React Router's `request.formData()` buffers the entire upload

For 1 GB uploads this is unacceptable — the whole file ends up in
memory before your action runs. Use a streaming multipart parser such
as `@mjackson/form-data-parser` or Busboy instead.

In React Router actions, prefer the Web `Request`-oriented parser:

```ts
import { parseFormData } from "@mjackson/form-data-parser";
// consume fileUpload.stream() inside the upload handler
```

If you ever bypass React Router and parse a raw Node `IncomingMessage`,
use the Node-specific parser entrypoint instead. Do not mix Web Request
parsers and raw Node stream parsers.

Pair this with a `Content-Length` check at the start to reject honest
over-limit clients before reading the body. Still keep the parser's own
max-file-size guard, because clients can lie about `Content-Length`.

### Upload parser examples can accidentally re-buffer files

Some streaming parser examples call helpers like `fileUpload.bytes` or
write a whole `File` object to disk. That materializes the upload in
memory and defeats the point of streaming.

For large recordings, pipe the upload stream directly to a temp file:

```ts
const dest = fs.createWriteStream(partialPath);
await fileUpload.stream().pipeTo(Writable.toWeb(dest));
```

Consume the upload stream inside the parser callback. Do not save the
`fileUpload` object and try to read it later; it is tied to the live
request body.

### Client disconnect cleanup is easy to miss

Large uploads fail halfway: laptops sleep, VPN drops, browser tabs
close. Always write to a temporary or partial path and delete it if the
request aborts or the write stream errors/closes before completion.

`request.signal` is the natural hook in a React Router action, but also
handle file-stream errors defensively. The cleanup path should remove
partial files and avoid inserting a `pending` Meeting row for an
incomplete upload.

### Upload progress is not free in React Router actions

A React Router action consumes the request and eventually returns one
response. It does not give you a built-in channel for live upload
progress.

For v1, an indeterminate upload spinner is acceptable. If exact upload
progress becomes important later, use a side channel such as polling or
SSE backed by server-side progress state.

### shadcn/ui doesn't ship a drag-and-drop primitive

The drop-target UI on the meeting list (and the upload confirmation
panel for split recordings) is hand-rolled HTML5 drag-and-drop. Plan
for ~50 lines of `onDragOver` / `onDrop` handlers; nothing exotic,
just don't expect a `<DropZone>` component to be there.

---

## Docker

### Use `python:3.12-slim`, not Alpine, for the worker

Whisper / pyannote / CTranslate2 wheels on PyPI are glibc-linked.
Alpine forces source builds and you'll spend a day fighting CUDA
toolchain mismatches. `python:3.12-slim` is small enough and just
works.

### File ownership across `web` and `worker` containers

`web` writes uploads into `/data/meetings/<uuid>/original.<ext>`.
`worker` reads them from the same volume. If the two containers run
as different UIDs (the default — node images use UID 1000, python
images use root), the worker can't read what the web wrote.

Fix: explicitly set a matching `USER` directive in both Dockerfiles
(e.g. UID 1000 in both), or `chmod` the volume on entrypoint. Pick
one, do it once; the bug is invisible until the first cross-container
file access.

### `slusko_meetings` named volume must outlive `docker compose down`

By default `docker compose down -v` (note the `-v`) deletes named
volumes. If anyone runs that on the production host, every meeting's
audio is gone. Document this loudly in the README's deploy section
and consider adding a guarded restart script that refuses to pass
`-v`.

---

## Misc

### ISO-prefixed export filenames need slugification

The download filename pattern `{iso_date}-{slugified_title}.md` falls
over if the title contains non-ASCII (Serbian Cyrillic or Latin with
diacritics). Use a slugifier that **transliterates** rather than
strips: e.g. `Štefica` → `stefica`, not `tefica`. The
`@sindresorhus/slugify` package does this correctly.

### Relative dates ("2 days ago") are timezone-sensitive

The list page uses relative dates. If the server renders them and
the user is in a different timezone, "yesterday" can read as "today."
Render relative dates **on the client**, after hydration, using the
browser's clock.

---

*Add new entries as they're discovered. Date them when relevant. If a
gotcha is permanently solved by the codebase (e.g. enforced by a lint
rule), move it from this file to the ADR or removal commit it lives
in.*
