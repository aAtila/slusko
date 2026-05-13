# Summarization System Prompt A/B Eval

Compares two versions of the summarization system prompt against the live
`OpenRouterSummarizer` code path, on a small set of synthetic Serbian /
English meeting transcripts crafted to exercise specific failure modes.

This is a **real** end-to-end test: it calls OpenRouter with whatever model
you have configured (`OPENROUTER_MODEL`, default `anthropic/claude-sonnet-4.5`).
Each (prompt × transcript) pair is run `--runs` times to estimate variance.

## Why this exists

This harness was introduced after the original `_system_prompt()` in
`slusko_worker.pipeline.summarization` used a real person name as the
canonical example value for a named action-item owner. That was a real
hallucination vector — the model could latch onto a name it saw in its own
system prompt and over-attribute work to that person even when the transcript
never named them. The prompt comparison keeps that failure mode covered while
also measuring whether stricter definitions of decision/action/open-question
improve summary quality.

It also addresses the longstanding `docs/gotchas.md` TODO to "plan an
evening to A/B Serbian summary quality" — the harness is structured so it
can be re-pointed at different `OPENROUTER_MODEL` values to repeat the
comparison across providers later.

## Usage

```bash
cd worker
export OPENROUTER_API_KEY=sk-or-...
export OPENROUTER_MODEL=anthropic/claude-sonnet-4.5  # or any OpenRouter model id

uv run python -m evals.summarization_prompt_ab.run_ab --runs 3
```

Outputs are written to
`worker/evals/summarization_prompt_ab/results/<timestamp>/`:

- `runs.jsonl` — one row per API call (prompt variant, transcript, attempt, draft, latency)
- `grading.json` — assertion pass/fail per run
- `report.md` — aggregated pass-rate table

## Cost

5 transcripts × 2 prompts × 3 runs = **30 OpenRouter calls** per session.
With `anthropic/claude-sonnet-4.5` and short transcripts this is well under
$1 per full sweep.
