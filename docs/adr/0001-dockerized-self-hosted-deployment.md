# ADR 0001 — Dockerized, self-hosted deployment

**Status:** Accepted
**Date:** 2026-05-01

## Context

Slusko needs a deployment model that supports two phases:

1. **Local development** on a developer's machine (mixed macOS / Linux).
2. **Production hosting** on a web server reachable through a domain, available
   to the whole internal team.

The PRD constrains us to centralized processing ("processing happens centrally,
not on user machines") and forbids external meeting bots. The team is also
cost-sensitive and dissatisfied with existing tools' Serbian support — both
arguments for keeping compute on infrastructure we control.

Alternatives considered:

- **Tailscale-only spare-box deploy** — rejected: blocks the "available via
  domain" target.
- **Pure cloud APIs** (OpenAI Whisper + GPT) — rejected for transcription
  because audio leaves our infrastructure; LLM-for-summarization remains an
  open question (see future ADR).
- **One developer's laptop** — rejected: not available when laptop sleeps.

## Decision

Slusko is delivered as a **Docker Compose stack**. The same compose file (with
environment overrides) runs locally during development and on a server we
control in production.

Two deployment phases are planned:

- **v1 — internal-network deployment.** The stack runs on a server reachable
  only over the company VPN. No public DNS, no external ingress, no
  authentication layer in the app itself; access control is delegated entirely
  to the VPN.
- **Later — public-domain deployment.** The same stack is rehosted on a
  publicly reachable server behind a domain over HTTPS. At that point
  authentication becomes mandatory. (See future ADR; not blocking v1.)

Compute (transcription, diarization, summarization) runs inside our containers,
on hardware we control. The boundary of "our data" is the host machine.

## Consequences

- The architecture is split across at least two services from day one:
  React Router app and Python worker. Likely additional services for the
  database and (probably) a queue.
- v1 ships **without an auth layer.** This is acceptable *only* because the
  VPN gates access. The codebase must not assume "no auth ever" — at minimum,
  every Meeting carries an `uploadedBy` string field so that an audit trail
  exists from day one and so a future auth ADR can attach identities cleanly.
- The hardware target for production is undecided (CPU vs. GPU). Code must
  work without a GPU; faster execution on a GPU host is a nice-to-have, not
  a hard dependency. (See future ADR.)
- Cloud LLM use for **summarization only** (text, not audio) remains open as
  a separate decision.
