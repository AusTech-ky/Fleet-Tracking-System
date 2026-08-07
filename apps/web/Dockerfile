# Production image for the FleetView web app (Next.js standalone output).
#
# NOTE: NEXT_PUBLIC_* values are inlined at BUILD time, so the API/WS URLs must
# be passed as build args — changing them later requires a rebuild, not just a
# restart. See docs/DEPLOYMENT.md.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_DEFAULT_BASEMAP=streets
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_DEFAULT_BASEMAP=$NEXT_PUBLIC_DEFAULT_BASEMAP \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1

# standalone output ships its own minimal node_modules.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

EXPOSE 3001
USER node
CMD ["node", "server.js"]
