# FleetView — all-in-one image for Coolify (and any "build from a Dockerfile" PaaS).
#
# Bundles the three services so a single build/deploy brings the whole platform
# up. Postgres and Redis are EXTERNAL (add them as Coolify resources and pass
# DATABASE_URL / REDIS_URL). Database migrations run automatically on start.
#
#   :3001  web app          (HTTP  — expose this as the main domain)
#   :3000  API / WS / GraphQL (HTTP — expose on a second domain)
#   :5027  device ingestion (RAW TCP — must be mapped as a TCP port, NOT HTTP)
#
# Trade-off: running three processes in one container is deliberate simplicity
# for a pilot. For independent scaling use docker-compose.prod.yml or
# infra/k8s/, which run each service separately. See docs/COOLIFY.md.

# ---------------------------------------------------------------- build: web
FROM node:22-alpine AS web-build
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json* ./
RUN npm ci
COPY apps/web/ ./
# NEXT_PUBLIC_* are inlined at build time — set these as Coolify build args.
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_DEFAULT_BASEMAP=streets
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_DEFAULT_BASEMAP=$NEXT_PUBLIC_DEFAULT_BASEMAP \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ------------------------------------------------- build: control-plane + deps
FROM node:22-alpine AS api-build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY services/control-plane ./services/control-plane
COPY services/ingestion ./services/ingestion
RUN npm install --no-audit --no-fund
RUN npm --workspace @fleet/control-plane run build

# -------------------------------------------------------------------- runtime
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

# Backend (control-plane compiled JS + ingestion TS, run natively by Node)
COPY --from=api-build /app/node_modules ./node_modules
COPY --from=api-build /app/services/control-plane/dist ./services/control-plane/dist
COPY --from=api-build /app/services/control-plane/package.json ./services/control-plane/package.json
COPY --from=api-build /app/services/ingestion ./services/ingestion
COPY --from=api-build /app/packages ./packages
COPY services/control-plane/migrations ./migrations

# Web (Next.js standalone bundle)
COPY --from=web-build /web/.next/standalone ./web
COPY --from=web-build /web/.next/static ./web/.next/static
COPY --from=web-build /web/public ./web/public

COPY docker/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh \
    # WAL dir must be owned by the runtime user, or the ingestion durability
    # sink fails with EACCES and devices are never acked.
    && mkdir -p /wal && chown -R node:node /wal

ENV MIGRATIONS_DIR=/app/migrations \
    WAL_DIR=/wal \
    PORT=3000 \
    WEB_PORT=3001 \
    TCP_PORT=5027 \
    HTTP_PORT=9100

EXPOSE 3000 3001 5027 9100
USER node
CMD ["/usr/local/bin/start.sh"]
