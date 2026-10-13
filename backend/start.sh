#!/usr/bin/env sh
# Railway entrypoint: migrate once, then serve.
# Multiple uvicorn workers each run lifespan; running Alembic there races
# and can hang cold starts past Railway proxy timeout (browser sees CORS/502).
set -eu
cd "$(dirname "$0")"
# Cap migrate time so a locked ALTER/INDEX cannot block boot forever (502).
if command -v timeout >/dev/null 2>&1; then
  if ! timeout 45 python -c "from db.migrate import run_migrations; run_migrations()"; then
    echo "WARNING: run_migrations timed out or failed — starting uvicorn anyway" >&2
  fi
else
  if ! python -c "from db.migrate import run_migrations; run_migrations()"; then
    echo "WARNING: run_migrations failed — starting uvicorn anyway" >&2
  fi
fi
export KAFI_SKIP_LIFESPAN_MIGRATE=1
# Single worker — two workers exhausted Supabase pool (SSL closed) and hung emails/WA/contacts.
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1
