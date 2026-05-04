# Slusko Worker

Minimal worker scaffold for Item 2.

## Scope right now

- Starts as a no-op process
- Verifies DB connectivity at startup (`SELECT 1`)
- Stays alive and logs idle status

Queue claiming/pipeline execution is intentionally not implemented yet.

## Schema ownership

- Canonical schema + migrations: `web/app/db/schema.ts` and `web/app/db/migrations`
- Worker mirrors only narrow queue/pipeline fields in `src/slusko_worker/db/models.py`

## Local run (without Compose)

```bash
cd worker
python -m venv .venv
source .venv/bin/activate
pip install .
DATABASE_URL=postgres://slusko:slusko@localhost:5432/slusko slusko-worker
```
