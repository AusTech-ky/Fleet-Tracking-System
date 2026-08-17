#!/usr/bin/env bash
# Mirror the PRODUCTION database into the local docker-compose Postgres, so
# dev shows exactly the tenants / devices / groups / history that live has.
#
# One-way and read-only against production: this only ever *reads* from prod
# (pg_dump) and *writes* to the local container. Nothing you do in dev
# afterwards can touch live.
#
# Usage:
#   PROD_DATABASE_URL='postgres://user:pass@host:5432/db' scripts/mirror-prod-db.sh
#
# The URL comes from Coolify -> your Postgres resource -> "Postgres URL
# (public)". Pass it via the environment, never commit it.
#
# Re-run any time to refresh the snapshot. It drops and recreates the local
# `fleet` database, so anything you created only in dev is discarded.
set -euo pipefail

# Git Bash on Windows rewrites POSIX-looking args (/tmp/x) into C:/... paths
# before docker sees them, so the container is told to write to a Windows path
# that doesn't exist inside it. Disabling the conversion keeps them intact.
export MSYS_NO_PATHCONV=1

: "${PROD_DATABASE_URL:?set PROD_DATABASE_URL to the production Postgres URL (from Coolify)}"
case "$PROD_DATABASE_URL" in
  postgres://*|postgresql://*) ;;
  *) echo "PROD_DATABASE_URL must be a real postgres:// URL from Coolify, not: $PROD_DATABASE_URL" >&2; exit 1 ;;
esac

cd "$(dirname "$0")/.."
DB_CONTAINER="$(docker compose ps -q db)"
[ -n "$DB_CONTAINER" ] || { echo "local db container is not running: docker compose up -d db redis" >&2; exit 1; }

# The local image is a plain Postgres 16; matching major means pg_dump/pg_restore
# inside it can talk to prod without version complaints.
echo "[mirror] dumping production (schema + data)…"
docker exec -e PGCONNECT_TIMEOUT=15 "$DB_CONTAINER" \
  pg_dump "$PROD_DATABASE_URL" \
    --format=custom --no-owner --no-privileges \
    --file=/tmp/prod.dump

echo "[mirror] recreating local 'fleet' database…"
docker exec "$DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='fleet' AND pid<>pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS fleet;" \
  -c "CREATE DATABASE fleet;"

# TimescaleDB must be pre-loaded before restoring hypertables into it, and the
# restore must run with its 'restoring' guard on — this is the documented
# procedure for restoring a Timescale dump.
echo "[mirror] restoring into local…"
docker exec "$DB_CONTAINER" psql -U postgres -d fleet -v ON_ERROR_STOP=1 -q \
  -c "CREATE EXTENSION IF NOT EXISTS timescaledb;" \
  -c "CREATE EXTENSION IF NOT EXISTS postgis;" \
  -c "SELECT timescaledb_pre_restore();"
docker exec "$DB_CONTAINER" \
  pg_restore -U postgres -d fleet --no-owner --no-privileges --exit-on-error /tmp/prod.dump
docker exec "$DB_CONTAINER" psql -U postgres -d fleet -q -c "SELECT timescaledb_post_restore();"
docker exec "$DB_CONTAINER" rm -f /tmp/prod.dump

echo "[mirror] done. Local now mirrors production:"
docker exec "$DB_CONTAINER" psql -U postgres -d fleet -At -c "
  SELECT '  tenants:  ' || count(*) FROM tenant
  UNION ALL SELECT '  devices:  ' || count(*) FROM device
  UNION ALL SELECT '  groups:   ' || count(*) FROM org_unit
  UNION ALL SELECT '  positions:' || count(*) FROM position;"
