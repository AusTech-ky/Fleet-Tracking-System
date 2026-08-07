# Production image for the Teltonika ingestion service.
# No build step: Node 22+ runs TypeScript natively (full transform for the
# decorators/parameter-properties this service uses).
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Workspace manifests first for layer caching. Only the two workspaces this
# service needs are copied, so the workspace globs resolve to what's present.
COPY package.json package-lock.json* ./
COPY packages/protocol-teltonika ./packages/protocol-teltonika
COPY services/ingestion ./services/ingestion

RUN npm install --omit=dev --no-audit --no-fund

# Device traffic (TCP+UDP) and the health/metrics port.
EXPOSE 5027/tcp 5027/udp 9100/tcp

# Create the WAL directory owned by the runtime user BEFORE declaring the
# volume. Docker seeds a named volume from the image path, so this is what
# makes the mounted volume writable by non-root — without it the durability
# sink fails with EACCES and the service can never ack a device.
RUN mkdir -p /wal && chown -R node:node /wal
VOLUME ["/wal"]

# Run as non-root.
USER node

# --enable-source-maps for readable stacks; transform-types to run .ts directly.
CMD ["node", "--experimental-transform-types", "--enable-source-maps", "services/ingestion/src/main.ts"]
