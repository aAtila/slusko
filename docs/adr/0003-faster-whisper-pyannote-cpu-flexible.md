# ADR 0003 — Transcription stack: faster-whisper + pyannote, CPU-flexible

**Status:** Accepted
**Date:** 2026-05-01

## Context

The Python worker needs to do two things to an uploaded meeting recording:

1. Produce a **transcript** with word-level (or at least segment-level)
   timestamps.
2. Produce **speaker labels** that group segments by who was talking
   (diarization).

The PRD names "Whisper / WhisperX" loosely. WhisperX bundles diarization but
is increasingly stale; the actively maintained ecosystem has converged on
**faster-whisper** (CTranslate2-based reimplementation of Whisper) for
transcription and **pyannote-audio** for diarization.

We considered:

- **Cloud APIs** (OpenAI Whisper, Groq, Deepgram). Rejected: ADR 0001 keeps
  audio on our hardware. OpenAI's Whisper API also has no diarization.
- **WhisperX**. Rejected: bundles the same components but is no longer the
  active maintenance frontier; harder to keep current.
- **whisper.cpp**. Strong on Apple Silicon but loses cross-platform parity
  with our Linux production target and would require us to bolt pyannote on
  separately anyway.

The PRD's loudest constraint is Serbian quality. Whisper `large-v3` is the
strongest open-weights model for Serbian, with materially better
code-switching handling than `large-v2` or `medium`.

## Decision

The Python worker uses **faster-whisper** for transcription and
**pyannote-audio 3.x** for diarization. Default model: **`large-v3`**.

The runtime (CTranslate2) is hardware-flexible: the same image runs on CPU,
NVIDIA CUDA, or Apple Silicon Metal by selecting `device=auto`. The worker
container does not require a GPU.

Diarization uses the `pyannote/speaker-diarization-3.1` pipeline. This
requires a HuggingFace access token in the worker's environment.

## Consequences

- **CPU-only deployments are supported.** Expect ~1× realtime: a 1-hour
  meeting takes ~1 hour to transcribe + diarize. Acceptable for an internal
  tool with asynchronous workflow ("drop a file, come back later").
- **GPU deployments are supported.** Expect 5–15× realtime depending on the
  card. This is how we hit the PRD's "few minutes per file" goal for typical
  meetings.
- The Docker image must work without `--gpus all`. GPU is detected at
  runtime; no separate "GPU build" of the image.
- A **HuggingFace token** becomes a required piece of operational config.
  Missing or invalid token must surface as a clear `Meeting.status="error"`
  message, not a silent failure.
- Model weights (~3GB for `large-v3`, ~1GB for pyannote) are downloaded on
  first run. The Docker image should pre-bake them into a model volume, or
  pre-pull them on container start, to avoid making the first-ever upload
  also be the first-ever download.
- Model size is a config value (`WHISPER_MODEL`), defaulting to `large-v3`.
  Smaller models (`medium`, `small`) are available as escape hatches if
  someone is testing on a very weak machine, but ship `large-v3` as default.
