# FleetView — GPS Fleet Tracking Platform

A production-grade, multi-tenant vehicle tracking platform built around
**Teltonika FTC927** trackers. Real-time map, geofencing, alerts, trip
detection, reporting, and a REST + GraphQL API.

Designed to be global from day one (multi-tenant, multi-timezone, swappable map
providers), with an initial deployment target of the Cayman Islands.

---

## What's here

| Package | Purpose |
|---|---|
| [`services/ingestion`](services/ingestion) | Device-facing TCP/UDP server. Teltonika **Codec 8 / 8E** decoding, CRC validation, ack-after-durable-write, dedupe, Codec 12 downlink, TLS. |
| [`services/control-plane`](services/control-plane) | NestJS API: tenants, auth (JWT + TOTP MFA), device provisioning, geofences, alerts, trips, reports, billing, GraphQL, `/rt` WebSocket feed. |
| [`apps/web`](apps/web) | Next.js + MapLibre PWA: live map, playback, geofence drawing, reports, settings. |
| [`packages/protocol-teltonika`](packages/protocol-teltonika) | Teltonika codecs, verified against the vendor's published test vectors. |
| [`packages/sdk`](packages/sdk) | Typed TypeScript client for the GraphQL API. |

**How data flows**

```
FTC927 ──raw TCP:5027──► ingestion ──Redis stream──► control-plane
                                                         │
                              PostGIS + TimescaleDB ◄─────┤
                                     Redis hot state ◄────┘
                                                         │
                                    web app ◄──REST/WS───┘
```

## Quick start (local)

```bash
npm install
docker compose up -d db redis          # PostGIS/TimescaleDB + Redis

# Backend demo (in-memory, no infra needed) + web app
npm --workspace @fleet/control-plane run build
npm --workspace @fleet/control-plane run demo     # :3000
cd apps/web && npm install && npm run dev         # :3001
```

Open http://localhost:3001 — the demo seeds a tenant, two departments and four
simulated vehicles (`demo@fleet.ky` / `password123`).

## Tests

```bash
npm test                                          # all workspaces
# Repository tests against real PostGIS/TimescaleDB:
docker compose up -d db
DATABASE_URL=postgres://postgres:fleet@localhost:5433/fleet \
  npm --workspace @fleet/control-plane run test:pg
```

## Deploying

| Path | Guide |
|---|---|
| **Coolify** (one Dockerfile) | [docs/COOLIFY.md](docs/COOLIFY.md) |
| **Single VM** (Docker Compose + TLS) | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| **Kubernetes / AWS** | [`infra/k8s`](infra/k8s), [`infra/terraform`](infra/terraform) |

> ⚠️ **Devices speak raw TCP on port 5027.** That traffic cannot pass through an
> HTTP reverse proxy, an ALB, or Cloudflare's proxy — the port must be exposed
> directly to the ingestion service. This is the most common deployment
> mistake. See the deployment guides.

## Architecture

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the system design, data
model, scaling path (100 → 1M+ devices), security model, and the phased
roadmap — including which Teltonika protocol details are **documented facts**
versus assumptions requiring verification.

## Status

The platform is feature-complete through reporting, notifications, user
management/MFA, sub-organizations, billing/quotas and GraphQL, and the
deployment path has been verified end-to-end with simulated devices.

**Not yet validated against physical hardware** — the protocol implementation is
verified against Teltonika's published test vectors and a device simulator, but
no real FTC927 has connected yet. Unparseable data is dropped *without* acking,
so devices retain and re-send it rather than losing data.
