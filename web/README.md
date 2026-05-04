# Slusko Web App

React Router v7 web application for Slusko.

## Prerequisites

- Node.js 22.x (matches `web/Dockerfile`)
- Bun 1.3.9

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
bun run dev
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
