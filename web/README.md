# Slusko Web App

React Router v7 web application for Slusko.

## Prerequisites

- Node.js 22.x
- Bun 1.3.9 (matches `web/Dockerfile`)
- PostgreSQL with `DATABASE_URL` set for DB-backed routes and migrations

## One-time setup

1. Install Lefthook (choose one):

```bash
# Homebrew
brew install lefthook

# mise
mise use -g lefthook@latest
```

2. From repo root, install git hooks:

```bash
lefthook install
```

3. From `web/`, install dependencies:

```bash
bun install
```

## Development

From `web/`:

```bash
export DATABASE_URL=postgres://slusko:slusko@localhost:5432/slusko
bun run db:migrate
bun run db:seed # optional: upsert sample meetings and transcript fixtures
# or: bun run db:seed:reset # optional: clear meetings first for deterministic QA data
bun run dev
```

## Compose workflow (from repo root)

```bash
docker compose up -d postgres
docker compose run --rm web bun run db:migrate
docker compose run --rm web bun run db:seed # optional sample meetings and transcript fixtures
# or: docker compose run --rm web bun run db:seed:reset # optional deterministic QA data
docker compose up web worker
```

## Production Compose workflow

From repo root, use the production compose file for Coolify/self-hosted deployments:

```bash
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` builds the web `production` target and runs the Dockerfile `start` command. Its one-shot `migrate` service builds the web `build` target so Drizzle config and migration files are available. The local-dev `docker-compose.yml` intentionally runs `bun run dev` with a source bind mount.

## Database commands

Drizzle is the canonical schema/migration tool for the web app. From `web/`:

```bash
bun run db:generate   # generate SQL from app/db/schema.ts
bun run db:migrate    # apply app/db/migrations to DATABASE_URL
bun run db:seed       # upsert sample local-development meetings and transcript fixtures
bun run db:seed:reset # delete existing meetings, then insert deterministic QA seeds
bun run db:studio     # inspect the database with Drizzle Studio
```

`db:seed` also replaces transcript rows for deterministic seed-owned meetings so local detail pages cover transcript lifecycle states. `db:seed:reset` deletes existing Meeting rows for the configured `DATABASE_URL` before inserting the QA fixtures. Use it only for local/dev databases where losing current Meeting data is expected.

## Quality checks

From `web/`:

```bash
bun run format
bun run format:check
bun run lint
bun run lint:fix
bun run test
bun run typecheck
bun run check
```

## Pre-commit behavior

Repo-root Lefthook runs on staged `web/` files:

- Prettier `--write` (and restages changes)
- oxlint gate (no autofix)
