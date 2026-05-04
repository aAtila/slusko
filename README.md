# Slusko

Compose-first local stack for Slusko (`postgres`, `web`, `worker`).

## Prerequisites

- Docker + Docker Compose v2
- Bun 1.3.9 (for local `web/` commands outside containers)

## Start the stack

From repo root:

```bash
# 1) Start database
docker compose up -d postgres

# 2) Apply Drizzle migrations from the web service image
docker compose run --rm web bun run db:migrate

# 3) Start app services
docker compose up web worker
```

Web app: http://localhost:5173

## Stop the stack

```bash
docker compose down
```

Do **not** run `docker compose down -v` unless you intentionally want to delete named volumes: local Postgres data (`postgres_data`), uploaded meetings (`slusko_meetings`), and model cache (`slusko_models`).
