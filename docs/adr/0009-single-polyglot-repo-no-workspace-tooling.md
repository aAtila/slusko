# ADR 0009 — Single polyglot repo, no workspace tooling

**Status:** Accepted
**Date:** 2026-05-04

## Context

ADR 0001 commits us to a Docker Compose stack with two app services:
React Router v7 framework-mode (`web`, Node) and a Python `worker`. ADR 0004
adds Postgres and confirms three first-class services total.

We need to decide how the source for those services is organized in version
control: one repo, two repos, or a "monorepo" with workspace tooling
(pnpm workspaces, Turborepo, Nx).

The two services share **no build-level code** — `web` is TypeScript and
`worker` is Python. The only things they actually share are (a) the
`meetings` table schema and (b) `docker-compose.yml`. There is no candidate
for a shared package, no cross-service TypeScript imports, no JS code the
worker needs to consume.

We considered:

- **Two separate repos.** Rejected: slusko is one product owned by one
  small team. Splitting introduces cross-repo PR coordination,
  separate issue trackers, and version-pinning friction across services
  for a unified deployment artifact (the Docker Compose stack). No upside
  proportional to that cost at our scale.
- **Single repo with JS workspace tooling** (pnpm workspaces, Turborepo,
  Nx). Rejected: workspace tooling exists to coordinate builds and share
  code between JS packages. We have exactly one JS package and zero
  shared JS code. Adding pnpm workspaces buys nothing today and adds
  conceptual surface (`packages/*` layout, hoisting rules, workspace
  protocols) that contributors must learn for no return.
- **Single repo, two top-level service folders, no workspace tooling.**
  Chosen.

## Decision

Slusko lives in **one git repo** with two top-level service folders:

```
/
├── web/                ← React Router v7 app (TypeScript, bun-as-PM)
├── worker/             ← Python worker (uv, sync psycopg3)
├── docker-compose.yml
├── CONTEXT.md
├── docs/
└── ...
```

There is **no `package.json` at the repo root**, no `pnpm-workspace.yaml`,
no `turbo.json`, no Nx configuration. `/web` and `/worker` are independent
projects that happen to live in the same git history.

`docker-compose.yml` lives at the repo root and references both services
via build context paths.

## Consequences

- **`/web` and `/worker` are managed independently.** Each has its own
  package manifest (`package.json` / `pyproject.toml`), its own lockfile,
  its own dependency upgrades, its own CI matrix.
- **`bun install` is run from `/web`, not from the repo root.** Same
  pattern for `uv sync` in `/worker`. Tooling docs in each service's
  README make this explicit.
- **Cross-service contracts** (the schema both sides write to, the env
  vars both sides read) are coordinated by the database itself and by
  `docker-compose.yml`, not by a shared TS package. See ADR 0010 for
  schema ownership.
- **Renaming or splitting later is cheap.** If a second JS package
  appears (e.g. a shared CLI), introducing `pnpm-workspace.yaml` is a
  ~5-minute migration: move `web/` to `packages/web/`, add the workspace
  manifest. Defer until that need actually exists.
- **CONTEXT.md and docs/ stay at the repo root**, not under either
  service. They describe the product (the Meeting domain), not either
  implementation.
- **Future contributor signal:** if you find yourself adding a third
  service or extracting a shared TS package, this ADR becomes a candidate
  for revisiting. The "no workspace tooling" call is right *for two
  language-isolated services*; it is not a forever rule.
