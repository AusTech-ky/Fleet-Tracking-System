#!/bin/sh
# Entrypoint for the all-in-one image: run migrations, then start all three
# services. If any one exits, kill the container so the platform restarts it
# (a silently half-dead container is worse than a restart loop you can see).
set -eu

echo "[start] running database migrations…"
node /app/services/control-plane/dist/src/migrate.js

pids=""
term() {
  echo "[start] shutting down…"
  # SIGTERM lets ingestion drain its device sockets gracefully.
  for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
  wait
  exit 0
}
trap term TERM INT

echo "[start] control-plane on :${PORT:-3000}"
node /app/services/control-plane/dist/src/main.js &
pids="$pids $!"

echo "[start] ingestion on tcp:${TCP_PORT:-5027}"
node --experimental-transform-types /app/services/ingestion/src/main.ts &
pids="$pids $!"

echo "[start] web on :${WEB_PORT:-3001}"
PORT="${WEB_PORT:-3001}" HOSTNAME=0.0.0.0 node /app/web/server.js &
pids="$pids $!"

# Exit as soon as ANY child dies, so the orchestrator notices.
wait -n
echo "[start] a service exited — stopping container"
term
