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
bun run dev
```

## Compose workflow (from repo root)

```bash
docker compose up -d postgres
docker compose run --rm web bun run db:migrate
docker compose up web worker
```

## Database commands

Drizzle is the canonical schema/migration tool for the web app. From `web/`:

```bash
bun run db:generate # generate SQL from app/db/schema.ts
bun run db:migrate  # apply app/db/migrations to DATABASE_URL
bun run db:studio   # inspect the database with Drizzle Studio
```

## Quality checks

From `web/`:

```bash
bun run format
bun run format:check
bun run lint
bun run lint:fix
bun run typecheck
bun run check
```

## Pre-commit behavior

Repo-root Lefthook runs on staged `web/` files:

- Prettier `--write` (and restages changes)
- oxlint gate (no autofix)
