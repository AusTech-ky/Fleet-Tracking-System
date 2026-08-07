# Fleet Tracking Platform — System Architecture

> Status: initial architecture (v0.1). Companion to the working ingestion
> prototype in [`services/ingestion-prototype`](../services/ingestion-prototype).
> Fact provenance is marked throughout: **[DOC]** = verified from Teltonika
> documentation, **[REC]** = recommendation/decision, **[TBV]** = to be verified.

---

## 0. Reading guide

This document is the design for a global, multi-tenant, cloud-native vehicle
tracking SaaS. Initial deployment: Cayman Islands; initial hardware: **Teltonika
FTC927**. It is organized as the 20 requested deliverables (§1–§20). The single
most consequential design driver is the device protocol (§4), so read that
first if you read nothing else.

---

## 1. High-level system architecture

Five independently deployable planes, so the protocol-critical ingest path never
shares a failure domain or a scaling curve with the web app.

```
                        ┌──────────────────────────────────────────────┐
  GPS devices  ──TCP───►│  INGEST PLANE  (raw TCP/UDP socket servers)   │
  (FTC927)     (+TLS)   │  Teltonika adapter · CRC · decode · ack       │
                        └───────────────┬──────────────────────────────┘
                                        │ normalized telemetry events
                                        ▼
                        ┌──────────────────────────────────────────────┐
                        │  STREAM BUS  (Kafka / Redpanda / Redis Stream)│
                        └───┬───────────────┬───────────────┬──────────┘
                            ▼               ▼               ▼
                  ┌────────────────┐ ┌──────────────┐ ┌───────────────┐
                  │ PROCESSING     │ │ HOT STATE     │ │ COLD STORE    │
                  │ rules/geofence │ │ Redis:last    │ │ Postgres+     │
                  │ alerts/trips   │ │ position/live │ │ PostGIS +     │
                  │ workers        │ │ WS fan-out    │ │ Timescale     │
                  └───────┬────────┘ └──────┬───────┘ └───────┬───────┘
                          │                 │                 │
                        ┌─┴─────────────────┴─────────────────┴──┐
                        │  API PLANE (NestJS: REST + GraphQL + WS)│
                        └───────────────────┬────────────────────┘
                                            ▼
                        ┌────────────────────────────────────────┐
                        │  WEB / PWA (Next.js + MapLibre)          │
                        └────────────────────────────────────────┘
```

**Why split ingest from API [REC]:** devices hold thousands of *persistent* TCP
sockets **[DOC — FTC927 "Permanent link" keeps a continuous connection]**. That
is a fundamentally different runtime (long-lived stateful sockets, connection
sharding, no HTTP LB) from the stateless request/response API. Coupling them
would force the whole system to scale on the harder curve.

**Data-flow contract:** ingest is dumb and fast — decode, validate, hand off,
ack. All business logic (geofencing, alerts, trips) is downstream consumers of
the stream bus. This keeps the device-facing acknowledgement latency low and
lets us reprocess history by replaying the bus.

---

## 2. Detailed backend architecture

Modular monolith at launch, service-extractable by seam **[REC]**. NestJS
modules with clean/hexagonal boundaries; the domain core has no framework or DB
imports (Domain-Driven Design where it earns its keep).

| Bounded context | Responsibility |
|---|---|
| `identity` | tenants, orgs/sub-orgs, users, RBAC, MFA, SSO |
| `devices` | provisioning, IMEI allow-list, config, firmware state |
| `ingest-adapters` | per-manufacturer protocol decoders (see §4, §20) |
| `telemetry` | position/IO time-series write + query |
| `geo` | geofences, spatial queries (PostGIS) |
| `rules` | alert rules engine, evaluation |
| `notify` | email/SMS/push/webhook fan-out |
| `trips` | trip/stop/idle derivation from raw positions |
| `reports` | report generation + export jobs |
| `billing` | plan/quota/metering (SaaS) |

**Extraction seams [REC]:** `ingest-adapters` and `reports` extract first —
ingest for its socket-scaling profile, reports for its CPU-burst profile. Each
context owns its tables; cross-context reads go through interfaces, never
foreign keys across seams, so a later split doesn't require a data migration.

**Async everywhere on the write path:** device → stream bus → consumers. BullMQ
(Redis) for job-style work (reports, firmware campaigns, tacho downloads);
Kafka/Redpanda for the high-throughput telemetry firehose. Redis for hot state
+ pub/sub to WebSocket gateways.

---

## 3. Frontend architecture

- **Next.js (App Router) + React + TypeScript**, **Tailwind + shadcn/ui**,
  **TanStack Query** for server state, **Zustand** for ephemeral map/UI state.
- **MapLibre GL JS [REC]** as the default renderer: vector tiles, WebGL
  performance for thousands of moving markers, no per-load fee, and a provider
  abstraction lets us swap the *tile source* (OSM, MapTiler, Mapbox, Google via
  raster) without touching map code. Leaflet is the raster fallback. Rationale:
  the map must render 1k+ live markers smoothly — that's a WebGL job, and
  MapLibre avoids Google's per-map-load billing at fleet scale.
- **Real-time:** a single WebSocket subscription per open map viewport;
  server pushes only deltas for vehicles in the current bbox/zoom (viewport
  culling) to bound bandwidth.
- **PWA:** installable, service-worker caches the app shell + last-known
  positions; offline shows cached state with a staleness banner. Full offline
  editing is out of scope v1 (tracking is inherently online).
- **Rendering strategy:** marker clustering + symbol layers on the GPU; historical
  playback uses a single GeoJSON line source with a time-scrubber updating a
  `filter` expression rather than re-adding features.

---

## 4. GPS ingestion architecture (the protocol-critical core)

### 4.1 Verified device contract (FTC927)

All of the following are **[DOC]** unless noted — sources: Teltonika wiki
*Codec*, *FTC927 Configuration*, *FTC927 Mobile network*, *FTC927 Teltonika Data
Sending Parameters ID* (fw 3.0.7+). The prototype implements and tests this.

- **Transport:** device is a **TCP client that dials out** to a configured
  `domain:port` (param 2004/2005); protocol TCP or UDP (param 2006). Optional
  **secondary server** (2007–2010) in **Backup** or **Duplicate** mode.
- **Security:** **TLS (TCP) / DTLS (UDP)** supported; certs pre-loaded on device
  via Configurator/FOTA. MQTT exists but is **TCP-only, non-TLS, Codec 8E
  payload only** → unsuitable as the secure primary path.
- **Login:** device sends `0x000F` + 15 ASCII IMEI digits; server replies
  `0x01` accept / `0x00` reject. **IMEI is the device identity** → auth is an
  allow-list check.
- **Data codecs:** Codec 8 (`0x08`), **Codec 8 Extended (`0x8E`)** — target, AVL
  IDs >255 — and Codec 16 (`0x10`).
- **TCP frame:** `preamble 0x00000000 | dataLen(4) | codecId | nRec | records… |
  nRec | CRC16(4)`. CRC = **CRC-16/IBM, poly 0xA001**, over the data field.
- **Ack:** server replies **4-byte big-endian record count**. Device **deletes
  acked records from flash only after a matching ack** → *ack after durable
  write*. UDP has no ack (fire-and-forget) → dedupe/ordering matters more.
- **Downlink:** GPRS commands to device = **Codec 12**.
- **Tachograph:** TBA file pull ≈350 KB over ≈20 min → slow-path worker, off the
  location hot path.
- **Connection style:** *Permanent link* + keep-alive ping ⇒ long-lived sockets.

### 4.2 Ingestion pipeline (modular, manufacturer-agnostic)

```
socket bytes → [FramingCodec] → [ProtocolDecoder] → [Normalizer] →
   [Deduper] → [DurableSink/bus] → [Acker]
```

Each stage is an interface; the **Teltonika adapter** is one implementation.
Adding a manufacturer = new `FramingCodec`+`ProtocolDecoder`+`Normalizer`, zero
changes downstream (see §20). The prototype realizes `FramingCodec`
(`extractFrame`), `ProtocolDecoder` (`decodeTcpPacket`), `Normalizer` (`mapIo` +
`FTC927_AVL`), and the `Acker` (`buildAck`), with dedupe/durable-sink stubbed as
the pluggable `Sink`.

**Correctness rules encoded in the prototype:**
1. **Ack only after the sink resolves** (durable-write-then-ack).
2. **CRC/framing error ⇒ drop socket without acking** so the device resends.
3. **Idempotency:** dedupe key `(imei, record-timestamp, payload-hash)` because
   Duplicate mode and reconnect-resend both cause replays.

### 4.3 Scaling the ingest tier

Stateless socket servers behind an L4 (TCP) load balancer (NLB), sharded by IMEI
hash. Each node holds N sockets; add nodes to add capacity. Because devices
reconnect on drop, rolling deploys are safe. See §9 for per-scale numbers.

---

## 5. Database schema & ERD

PostgreSQL 16 + **PostGIS** (spatial) + **TimescaleDB** (hypertables for the
telemetry firehose) **[REC]**. Multi-tenant via a `tenant_id` column + Row-Level
Security (see §8).

```
tenant 1─* organization 1─* org_unit(department)
organization 1─* user  *─* role  (role 1─* permission)
organization 1─* vehicle  *─1 device   (device 1─* position[])
organization 1─* driver   driver *─* vehicle (assignment, time-bounded)
organization 1─* geofence
organization 1─* alert_rule 1─* alert_event
vehicle 1─* trip 1─* stop
```

Core tables (abbreviated):

```sql
-- Hot time-series (Timescale hypertable, partitioned by time, then tenant)
CREATE TABLE position (
  tenant_id    uuid        NOT NULL,
  device_id    uuid        NOT NULL,
  ts           timestamptz NOT NULL,      -- device record time
  geom         geography(Point,4326),     -- PostGIS, WGS84
  speed_kph    real,
  heading      smallint,
  altitude     smallint,
  satellites   smallint,
  ignition     boolean,
  ext_voltage  integer,                   -- mV (AVL 800)
  attrs        jsonb,                      -- remaining mapped + raw AVL IDs
  PRIMARY KEY (device_id, ts)
);
SELECT create_hypertable('position','ts', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX ON position USING gist (geom);         -- spatial
CREATE INDEX ON position (tenant_id, device_id, ts DESC);
-- Retention/compression: compress chunks > 7d, drop raw > 400d (config).
```

`attrs jsonb` keeps forward-compat with unmapped AVL IDs (we never drop data we
don't yet model). Latest position is served from Redis, not this table.

---

## 6. Geospatial data model

- **SRID 4326** stored as `geography` for correct metric distance on a sphere;
  cast to `geometry` for planar ops where speed matters.
- **Geofences:** `geometry(Polygon|MultiPolygon)` for polygon/multi-zone;
  circles stored as center+radius and evaluated with `ST_DWithin` (avoids
  polygon approximation error); route corridors as `ST_Buffer` of a linestring.
- **Queries:** entry/exit via consecutive-position `ST_Contains`/`ST_DWithin`
  transitions; "vehicles in view" via `ST_MakeEnvelope` bbox + GiST index;
  nearest-vehicle via `<->` KNN operator.
- **Dwell time** and speed-in-zone computed in the rules consumer from position
  transitions, not at query time.

---

## 7. API specification

- **REST** (resource CRUD, reports, exports) — OpenAPI 3 generated from NestJS
  decorators. Versioned by URI prefix `/api/v1`.
- **GraphQL** for the dashboard's read-heavy, nested fleet/vehicle/driver graphs
  (one round trip, client-selected fields) **[REC]** — mutations stay REST for
  simpler idempotency/rate-limit semantics.
- **WebSocket** `/rt` — subscribe to `tenant:{id}:positions` filtered by
  viewport; server pushes position/alert deltas.
- **Webhooks** — outbound, HMAC-signed, per-tenant, with retry+DLQ.
- Cross-cutting: cursor pagination, `Idempotency-Key` on mutations, rate limits
  (§8), `ETag`/`If-None-Match` on reports. SDKs: generate TS + Python clients
  from OpenAPI; publish a thin JS SDK for the webhook signature verify.

Representative endpoints:
```
POST /api/v1/devices            provision (IMEI, model, tenant)
GET  /api/v1/vehicles?bbox=...  list within map bounds
GET  /api/v1/vehicles/:id/history?from&to   playback
POST /api/v1/geofences          create (GeoJSON)
POST /api/v1/alert-rules        create rule
GET  /api/v1/reports/:id/export?format=pdf|xlsx|csv
```

---

## 8. Authentication & security model (combined §8 + §9)

- **Users:** JWT access (short TTL, ~10 min) + rotating refresh tokens (httpOnly,
  secure cookie), **MFA (TOTP)**, **SSO-ready** (OIDC/SAML) via an auth module
  boundary. **RBAC** with custom permissions per tenant; enforced in a NestJS
  guard + mirrored in Postgres **Row-Level Security** so a query bug can't cross
  tenants.
- **Devices:** IMEI allow-list (provisioned only), optional **TLS/DTLS** with
  device certs; per-device rate/shape limits to blunt a rogue/spoofed unit.
- **In transit:** TLS everywhere (user HTTPS, device TLS, internal mTLS between
  planes). **At rest:** disk/volume encryption + column encryption for secrets;
  secrets in a managed vault (AWS Secrets Manager / KMS), never in env files in
  prod.
- **App hardening:** parameterized queries/ORM (SQLi), output encoding + CSP
  (XSS), CSRF tokens on cookie-auth mutations, per-tenant + per-IP rate limiting
  (Redis token bucket), audit log of every privileged action, structured
  security events to the SIEM. **[REC]**

---

## 9. Scalability (per device tier)

The device count drives the *ingest* tier (sockets); user count drives the *API*
tier (requests). They scale separately.

| Devices | Ingest | Datastore | Notes |
|---|---|---|---|
| 100 | 1 small node | single Postgres | dev/pilot (Cayman launch) |
| 1k | 1–2 nodes | Postgres + Redis | Timescale compression on |
| 10k | 3–5 nodes, IMEI-sharded | read replicas | stream bus mandatory |
| 100k | autoscaled fleet, multi-AZ | Timescale multi-node / Citus | consumer groups scale out |
| 1M+ | multi-region ingest edges | sharded by tenant/region | per-region write, global read via replicas |

At ~1 record/30 s, 1M devices ≈ **33k writes/s** sustained — a stream-bus +
batched-copy-into-Timescale problem, not a per-row-INSERT problem. Every plane is
horizontally scalable and stateless except the socket servers (sticky by IMEI
via L4 hash).

---

## 10–12. Infrastructure, deployment & CI/CD

- **Containers** (Docker) on **Kubernetes** **[REC: managed — EKS/GKE]**. Cloud:
  **AWS** as the reference (NLB for TCP ingest, MSK/Redpanda, RDS+Timescale or
  self-managed, ElastiCache, S3 object store, ACM/KMS). Portable — no exotic
  lock-in.
- **IaC:** Terraform for cloud infra; Helm for app releases.
- **Environments:** dev → staging → prod, prod multi-AZ.
- **CI/CD (GitHub Actions):** lint+typecheck → unit → integration (ephemeral
  Postgres/Redis) → build+scan images → deploy staging → smoke/e2e →
  progressive prod rollout (canary). The ingestion decoder ships with the vendor
  test vectors (already green) as a merge gate.
- **Ingest deploys** are rolling with connection draining; devices reconnect
  automatically, so no data loss during rollout (unacked records resend).

---

## 13–14. Observability & logging

- **Metrics (Prometheus/Grafana):** sockets open, records/s, decode-error rate,
  CRC-failure rate, ack latency, bus lag, geofence-eval latency, per-tenant
  ingest volume.
- **Tracing (OpenTelemetry):** device-record → bus → consumer → alert, one trace.
- **Logs:** structured JSON, correlation IDs, shipped to Loki/ELK; **no PII or
  raw position in logs** beyond IMEI + counts.
- **Alerting on the platform itself:** decode-error spike (firmware/format
  regression), device-offline cliff (carrier/APN outage), bus lag (consumer
  fallback).

---

## 15. Performance strategy

Hot-path last-position reads from Redis (never hit Timescale); telemetry writes
batched via `COPY`; spatial queries backed by GiST + bbox pre-filter; WebSocket
viewport culling; report generation offloaded to workers with object-store
output + signed URLs; vector tiles + client-side clustering for map render.

---

## 16. Development roadmap (phased)

| Phase | Outcome |
|---|---|
| **0 (done)** | Protocol verified; Codec 8/8E TCP ingestion prototype, tested against vendor vectors + live-socket e2e. |
| **1 — Ingest + control plane + live map (done)** | ✅ `services/ingestion`: TCP+TLS+UDP, Codec 8/8E/12, dedupe, WAL+bus sinks (ack-after-write), downlink, metrics/health, graceful drain, simulator. ✅ `services/control-plane` (NestJS): tenants, JWT+RBAC, provisioning, **allow-list sync to ingestion via Redis**, telemetry consumer → PostGIS/Timescale, latest/history API, **`/rt` WebSocket live feed**, RLS migration, docker-compose. ✅ `apps/web` (Next.js + MapLibre PWA): login, live map + basemap layers, route playback. ✅ **Real-infra integration validated** — docker-compose PostGIS+Timescale+Redis, 7 pg integration tests + full API→stream→DB→query path proven on real infrastructure (caught & fixed 3 real bugs: migration compression/RLS conflict, timestamptz→Date type mismatch, config-merge NULL violation). ⏳ Remaining: run against real FTC927 units in Cayman. |
| **2 — Core platform (mostly done)** | ✅ Pure rules engine (geometry, geofence containment, alert evaluation, trip detection) — unit-tested. ✅ Geofence CRUD, alert events + config API, trips API, wired into the telemetry consumer with a device-offline sweep, alerts pushed over WS. ✅ Web: geofences on map, live alerts panel, **playback timeline scrubber**, offline-safe blank map style. **71 tests green.** ✅ **Geofence drawing UI** — draw circles/polygons on the map, name & save, list & delete (verified end-to-end). ⏳ Remaining: alert delivery beyond in-app/WS (email/SMS/webhook). |
| **3 — Reports, notifications, users/MFA (mostly done)** | ✅ Reporting engine + CSV/Excel/PDF exporters + web Reports page. ✅ **Alert notifications** — webhook (HMAC-signed, retry) + email channels behind an interface, per-tenant config, dispatcher wired into the consumer, test-send. ✅ **User management** — admin CRUD, roles, activate/deactivate. ✅ **MFA (TOTP, RFC 6238)** — enroll/enable/disable + login challenge; MFA tokens rejected as API tokens. ✅ Web **Settings page** (notifications, security/MFA, team, departments) + login MFA challenge. ✅ **Sub-orgs/departments** — org-unit tree, `department_id` on devices+users, JWT carries departmentId, **subtree access-scoping** (a department-scoped user sees only its subtree's devices/positions/reports). **116 tests**, real-DB validated. ⏳ Remaining: SMS/push channels (need Twilio/FCM). |
| **4 — SaaS & scale (in progress)** | ✅ **Billing/quotas** — plan catalog, per-tenant subscription, usage metering, quota enforcement (402) on device/user provisioning, `/billing` API + Settings UI, payment-provider port (fake + Stripe-shaped). ✅ **GraphQL** API (`/graphql`) over the services (auth + department scoping) + **`@fleet/sdk`** typed client (login + queries + mutation), live-smoked against the real API. **131 tests.** ✅ **Deployment infrastructure** — production `docker-compose.prod.yml` (+ Caddy TLS, `.env.prod.example`) **built and verified end-to-end**: all images build, a device flows through containerized ingestion → Redis → PostGIS. Full runbook in [DEPLOYMENT.md](DEPLOYMENT.md). K8s manifests (NLB for raw-TCP device traffic, HPA on connection count) + Terraform (VPC/EKS/RDS Multi-AZ/ElastiCache) — `terraform validate` passes, **not applied to live infra**. |
| **Hardening (done, cross-cutting)** | ✅ Rate limiting (per-IP, `@nestjs/throttler`, 429). ✅ **OpenAPI/Swagger** at `/docs` + `/openapi.json`. ✅ Security headers (helmet). ✅ Consistent error envelope + **request-id** + access logging. ✅ **CI/CD** — GitHub Actions: test all workspaces + pg-integration on real PostGIS/Timescale+Redis service containers + web build + Docker image builds. |
| **5 — Extensibility** | 2nd manufacturer adapter (proves §20), tachograph slow-path, advanced driver behavior, i18n/localization. |

---

## 17. Project folder structure

```
gps-tracking/
├─ docs/                      architecture, ADRs, runbooks
├─ services/
│  ├─ ingestion-prototype/    ← this PoC (Codec 8/8E, tested)
│  ├─ ingestion/              productionized socket servers
│  ├─ api/                    NestJS: REST+GraphQL+WS
│  └─ workers/                rules, alerts, reports, trips
├─ packages/
│  ├─ protocol-teltonika/     decoders (extracted from PoC)
│  ├─ protocol-core/          FramingCodec/Decoder/Normalizer interfaces
│  ├─ domain/                 framework-free domain model
│  └─ sdk/                    generated API clients
├─ apps/
│  └─ web/                    Next.js PWA
├─ infra/
│  ├─ terraform/              cloud infra
│  └─ helm/                   k8s releases
└─ .github/workflows/         CI/CD
```

---

## 18. Coding standards

TypeScript strict everywhere; ESLint + Prettier; conventional commits; domain
layer has zero framework/DB imports; errors are typed (see `TeltonikaDecodeError`)
never bare strings; all protocol constants trace to a cited doc; no magic numbers
in decoders (named per the AVL table). Public APIs get JSDoc; ADRs record every
"[REC]" decision here.

---

## 19. Testing strategy

- **Unit:** decoders against **vendor test vectors** (done — CRC matches
  `0xC7CF`, Codec 8/8E samples decode), rules engine, geofence math.
- **Integration:** live TCP socket e2e (done — handshake→decode→ack), API +
  ephemeral Postgres/Redis, RLS tenant-isolation tests.
- **E2E:** Playwright over the web app (login → map → playback → alert).
- **Load:** a device simulator fan-out (extend the PoC's session runner) to
  100k synthetic FTC927 sockets; measure records/s, ack latency, bus lag.
- **Property/fuzz:** feed malformed frames to the decoder (partial, bad CRC,
  wrong count) — already covered for CRC/fragmentation; extend with a fuzzer.

---

## 20. Extensibility for new manufacturers

The `protocol-core` interfaces (`FramingCodec`, `ProtocolDecoder`,
`Normalizer`) are the contract. A new vendor (e.g. Queclink, Concox) is:
1. a `FramingCodec` for its wire framing,
2. a `ProtocolDecoder` producing the same `AvlRecord`-shaped normalized event,
3. a `Normalizer`/ID map to canonical field names,
4. registered by listener port or by a protocol sniff on first bytes.

Everything downstream (bus, storage, rules, UI) is manufacturer-agnostic because
it only ever sees normalized telemetry. The Teltonika adapter in the prototype
is the reference implementation of this contract.

---

## Open items to verify [TBV]

1. FTC927 support for UDP+DTLS in the field with the chosen Cayman carrier.
2. Cayman carrier **APN / SIM** specifics and whether static IPs or NAT
   traversal affect the dial-out model.
3. Full AVL-ID table beyond the modeled subset (kept in `attrs` jsonb until
   modeled).
4. Tachograph (Codec 12 / file transfer) exact flow — deferred to Phase 5.
```
