#!/usr/bin/env bash
# Run the dev stack against REAL data (the local Postgres mirror of production)
# instead of the in-memory demo with its fake seeded vehicles.
#
#   docker compose up -d db redis          # once
#   PROD_DATABASE_URL=… scripts/mirror-prod-db.sh   # pull live data (repeatable)
#   scripts/dev-real.sh                    # this
#
# Then open http://localhost:4301 and sign in with your PRODUCTION credentials —
# it's the same users table.
#
# What this deliberately does NOT do: run ingestion. Your live FTC927 dials
# fleetapi.swift.ky:5027, so new positions land in production; the mirror is a
# snapshot as of the last mirror-prod-db.sh run. Re-run that to catch up.
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT="${API_PORT:-4300}"
WEB_PORT="${WEB_PORT:-4301}"
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:fleet@localhost:5433/fleet}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
# Local-only secret. Tokens minted here are NOT valid against production and
# vice versa, which is exactly what you want from a dev environment.
export JWT_SECRET="${JWT_SECRET:-dev-only-secret-not-for-prod}"
export CORS_ORIGINS="http://localhost:${WEB_PORT}"
export PORT="$API_PORT"

# Fail loudly if the mirror hasn't been taken — the empty-DB experience is
# indistinguishable from "it's broken".
if ! docker compose exec -T db psql -U postgres -d fleet -Atc "SELECT 1 FROM tenant LIMIT 1" 2>/dev/null | grep -q 1; then
  echo "local 'fleet' DB has no tenants. Mirror production first:" >&2
  echo "  PROD_DATABASE_URL='postgres://…' scripts/mirror-prod-db.sh" >&2
  exit 1
fi

echo "[dev-real] control-plane on :$API_PORT  (postgres+redis, real data)"
( cd services/control-plane && npm run build --silent && node dist/src/main.js ) &
API_PID=$!

echo "[dev-real] web on :$WEB_PORT  -> API http://localhost:$API_PORT"
( cd apps/web && NEXT_PUBLIC_API_URL="http://localhost:$API_PORT" npx next build >/dev/null && \
    NEXT_PUBLIC_API_URL="http://localhost:$API_PORT" npx next start -p "$WEB_PORT" ) &
WEB_PID=$!

trap 'kill $API_PID $WEB_PID 2>/dev/null' INT TERM
wait
