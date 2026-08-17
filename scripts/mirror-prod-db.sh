#!/usr/bin/env bash
# Mirror PRODUCTION into the local docker-compose Postgres, so dev shows exactly
# the tenants / devices / groups / history that the live site has.
#
# Read-only against production, over SSH. The live DB never needs a public
# port. Nothing you do in dev afterwards can touch live — it's a copy.
#
#   scripts/mirror-prod-db.sh                 # uses defaults below
#   SSH_HOST=root@1.2.3.4 scripts/mirror-prod-db.sh
#
# Re-run any time to refresh. It rebuilds the local `fleet` database from our
# own migrations, then loads prod's rows into it — so anything created only in
# dev is discarded.
#
# Why not pg_dump the whole cluster? Two reasons, both learned the hard way:
#  - Timescale's private catalog (_timescaledb_catalog.*) differs between
#    versions; restoring prod's into a different local Timescale fails.
#  - `position` is a hypertable: its rows live in chunk tables that
#    `pg_dump -t position` silently skips. COPY through the parent sees them all.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: stop it rewriting /tmp paths for docker

SSH_HOST="${SSH_HOST:-root@167.99.49.143}"
PROD_DB_CONTAINER="${PROD_DB_CONTAINER:-fgqzmk8mngq9konp9tu6dkcv}"   # Coolify's fts-pg (timescale image)
PROD_DB_NAME="${PROD_DB_NAME:-fleet}"

cd "$(dirname "$0")/.."
DB="$(docker compose ps -q db)"
[ -n "$DB" ] || { echo "local db not running: docker compose up -d db redis" >&2; exit 1; }

# App tables in FK-safe load order. `position` is handled separately (hypertable).
TABLES="tenant org_unit app_user vehicle device geofence alert_config notification_config subscription refresh_token alert_event trip"

prod() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$SSH_HOST" \
  "docker exec $PROD_DB_CONTAINER psql -U postgres -d $PROD_DB_NAME -Atq -c \"$1\""; }

echo "[mirror] checking SSH + prod DB…"
prod "select 'ok'" | grep -q ok || { echo "cannot reach prod DB via $SSH_HOST" >&2; exit 1; }

echo "[mirror] rebuilding local 'fleet' from migrations…"
docker exec "$DB" psql -U postgres -q \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='fleet' AND pid<>pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS fleet;" -c "CREATE DATABASE fleet;" >/dev/null
for f in services/control-plane/migrations/*.sql; do
  docker exec -i "$DB" psql -U postgres -d fleet -q -v ON_ERROR_STOP=1 < "$f" >/dev/null
done

echo "[mirror] copying rows prod → local…"
# Defer FK checks for the batch (org_unit self-references; load order alone
# can't satisfy a parent that sorts after its child).
for t in $TABLES; do
  ssh -o BatchMode=yes "$SSH_HOST" \
    "docker exec $PROD_DB_CONTAINER psql -U postgres -d $PROD_DB_NAME -Atc \"\\copy (select * from $t) to stdout\"" \
    | docker exec -i "$DB" psql -U postgres -d fleet -q \
        -c "SET session_replication_role = replica;" \
        -c "\\copy $t from stdin"
  printf "  %-20s %s\n" "$t" "$(docker exec "$DB" psql -U postgres -d fleet -Atc "select count(*) from $t")"
done
ssh -o BatchMode=yes "$SSH_HOST" \
  "docker exec $PROD_DB_CONTAINER psql -U postgres -d $PROD_DB_NAME -Atc \"\\copy (select * from position order by ts) to stdout\"" \
  | docker exec -i "$DB" psql -U postgres -d fleet -q -c "\\copy position from stdin"
printf "  %-20s %s\n" "position" "$(docker exec "$DB" psql -U postgres -d fleet -Atc "select count(*) from position")"

echo "[mirror] done. Local mirrors production as of now."
