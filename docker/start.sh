#!/bin/sh
# Entrypoint for the all-in-one image: run migrations, then start all three
# services. If any one exits, kill the container so the platform restarts it
# (a silently half-dead container is worse than a restart loop you can see).
set -eu

echo "[start] running database migrations…"
node /app/services/control-plane/dist/src/migrate.js

pids=""
# Exit code to hand back. 0 for a requested shutdown; non-zero when we are
# stopping because a child died, so the platform's restart policy actually
# fires (Coolify/Docker restart on non-zero, and `always` restarts either way).
rc=0
term() {
  echo "[start] shutting down…"
  # SIGTERM lets ingestion drain its device sockets gracefully.
  for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
  wait
  exit "$rc"
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
#
# NOT `wait -n`: that is a bash builtin, and this image's /bin/sh is Alpine's
# ash, which ignores the -n and waits for ALL children. In production that
# meant a crashed control-plane left the container "healthy" for an hour with
# web + ingestion still up and the API dead. Poll the pids instead — portable
# to any POSIX sh — and stop the moment one is gone.
while :; do
  for p in $pids; do
    if ! kill -0 "$p" 2>/dev/null; then
      echo "[start] a service (pid $p) exited — stopping container so it can be restarted"
      rc=1
      term
    fi
  done
  sleep 2
done
