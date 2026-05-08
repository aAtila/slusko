# ADR 0002 — Cloud LLM via OpenRouter for summarization

**Status:** Accepted
**Date:** 2026-05-01

## Context

The summarization step takes a finished transcript (text only, no audio) and
produces a structured `Summary` object with overview, decisions, action items,
and open questions. The PRD's loudest pain point is *"existing tools don't
support Serbian well"* — so the chosen LLM must produce high-quality Serbian
output.

Three families of options were considered:

1. **Cloud LLM via direct API** (Anthropic, OpenAI, Google).
2. **Cloud LLM via headless agent CLIs** — running Claude Code or Codex CLI
   inside the worker container, authenticated through someone's personal
   subscription.
3. **Local LLM** running in the Docker stack (Llama, Qwen, etc.).

Option 2 was attractive ("the team already pays for Claude/ChatGPT") but
rejected on three independent grounds:

- **Subscription terms forbid it.** Both Anthropic and OpenAI scope personal
  subscriptions (Claude Pro/Max, ChatGPT Plus/Pro) to one human's interactive
  use. Sharing tokens or building services on top is a TOS violation and
  results in account bans.
- **Rate limits are sized for one human**, not a team service.
- **Agent CLIs are the wrong shape** for "text in → strict JSON out." They are
  planning loops with tool use; we want a single structured-output call.

Option 3 was rejected for v1: the open-weights models small enough to
self-host on a single GPU are noticeably weaker at Serbian than frontier APIs,
and the v1 audience can't afford a bad-Serbian-summary first impression.

## Decision

For v1, summarization is performed by a **cloud LLM accessed through
OpenRouter**, billed to a single company-owned API key.

The integration lives behind a `Summarizer` interface in the Python worker.
The interface accepts `(transcript: list[Segment], speaker_map: SpeakerMap)`
and returns a validated `Summary`. Any code outside the worker's summarizer
module must not know which model or which provider answered the call.

OpenRouter is chosen over direct provider APIs because:

- It exposes Anthropic, OpenAI, Google, and open-weights models behind a
  single OpenAI-compatible endpoint, so model selection becomes a config
  value rather than an integration change.
- It centralizes billing and usage observability.
- The portability cost is small (an OpenAI-compatible client is ~50 lines)
  and the lock-in cost of *not* using it (re-integrating to evaluate a new
  model later) is large.

## Consequences

- The boundary of "data we keep on our hardware" is **the audio file and the
  raw transcript**. The summarization step sends transcript text to a
  third-party LLM provider.
- This is acceptable for v1 because the team has agreed no class of meeting
  in scope contains content that would forbid third-party text processing.
  *If that ever becomes false for a category of meeting, this ADR must be
  revisited before processing such meetings.*
- v1 adds a new operational dependency: an OpenRouter account with funded
  credit. Failure modes (out of credit, rate-limited, model deprecated)
  must surface as a `Meeting.status = "error"` with a clear message.
- Model selection is a runtime config (`OPENROUTER_MODEL`), not a code
  constant. **The v1 default is `anthropic/claude-sonnet-4.5`**, chosen
  on 2026-05-08 after the maintainer ran representative Serbian and
  Serbian/English code-switched meetings through it during build-out and
  judged the outputs production-ready for MVP — overview faithfulness,
  decision extraction, action item ownership, and preservation of
  technical/product terms in their original language all met the bar.
  This is a deliberate update from the PRD-listed `claude-sonnet-4` to
  the newer point release in the same Anthropic family. The other
  PRD-listed candidates (`openai/gpt-4o`, `google/gemini-2.5-pro`)
  remain valid swaps; the model is a runtime env var, so revisiting the
  default once real-world usage surfaces concrete failure modes costs
  nothing in code.
- Personal Claude / ChatGPT subscriptions are **never** used to authenticate
  the worker. Headless agent CLIs are not permitted as the summarization
  backend.
