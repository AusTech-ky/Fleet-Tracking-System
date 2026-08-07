# Control-plane (NestJS). Unlike the ingestion tier this service uses a tsc
# build step (standard NestJS: decorators need emitDecoratorMetadata).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY services/control-plane ./services/control-plane
RUN npm install --no-audit --no-fund
RUN npm --workspace @fleet/control-plane run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/control-plane/dist ./services/control-plane/dist
COPY --from=build /app/services/control-plane/package.json ./services/control-plane/package.json
EXPOSE 3000
USER node
CMD ["node", "services/control-plane/dist/src/main.js"]
