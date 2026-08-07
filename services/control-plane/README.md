# @fleet/control-plane — Provisioning + Telemetry API (NestJS)

The control plane: multi-tenant provisioning, auth/RBAC, and telemetry
persistence. It turns "bytes acked by ingestion" into "vehicles you can query."
See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §2, §5, §7, §8.

**16 tests pass** (10 HTTP e2e against a live Nest app + 6 guard unit tests),
provable **without a database** via in-memory repositories.

## What it does

| Area | Detail |
|---|---|
| **Auth** | `POST /auth/register-tenant` (bootstraps tenant + admin), `POST /auth/login`. JWT (scrypt password hashing, no external hash dep). |
| **RBAC** | `admin` / `operator` / `viewer`, enforced by a global `RolesGuard`. |
| **Tenant isolation** | Every query is tenant-scoped; mirrored by Postgres **Row-Level Security** in the migration. |
| **Devices** | Provision (IMEI + model), list, get, status change, delete — all tenant-scoped. |
| **Allow-list sync** | Provisioning **publishes the IMEI to the shared Redis set** ingestion authenticates against — no ingestion redeploy. Status→suspended/retired revokes it. On boot, the list is fully resynced from the DB (self-healing). |
| **Vehicles** | Create, list, get, link a device. |
| **Telemetry consumer** | Reads the `telemetry` stream ingestion produces, resolves IMEI→device, persists to the time-series store, and updates hot last-known state (at-least-once; positions idempotent by `(device_id, ts)`). |
| **Query** | `GET /devices/:id/latest` (hot state), `GET /devices/:id/history?from&to` (time-series). |
| **Reports** | `GET /reports?type=trips\|speeding\|geofence\|summary\|fleet&deviceId&from&to` (JSON) and `GET /reports/export?...&format=csv\|xlsx\|pdf` (download). Pure aggregation engine (`src/engine/reports.ts`) → generic tabular report → CSV/Excel/PDF exporters (`src/reports/exporters.ts`). |
| **Notifications** | `GET/PUT /notification-config`, `POST /notification-config/test`. Webhook (HMAC-SHA256 `X-Fleet-Signature`, retry) + email channels (`src/notifications/`), dispatched from the telemetry consumer on each alert (best-effort). SMTP via `SMTP_URL` (else dev log transport). |
| **Users** | `GET/POST /users`, `PATCH /users/:id` (admin-only) — create, role change, activate/deactivate, department assignment. Secrets never returned. |
| **Departments (sub-orgs)** | `GET/POST /departments`, `DELETE /departments/:id`. Org-unit tree (`parent_id`); devices + users carry `department_id`. A user with a `departmentId` is **scoped to that subtree** — device list, single-device access, positions, and reports only cover devices in their department and its descendants (`src/engine/org.ts` computes the subtree; `DevicesService` enforces it). Assign a device via `PATCH /devices/:id/department`. |
| **Billing / quotas** | `GET /billing` (plan, limits, usage, available plans), `POST /billing/subscribe` (admin). Plan catalog + quota logic in `src/billing/plans.ts`; provisioning a device/user beyond the plan limit returns **402**. Payment behind a `PaymentProvider` port (fake by default; `StripePaymentProvider` when `STRIPE_KEY` is set). |
| **GraphQL** | `/graphql` — code-first schema over the same services with the same auth + department scoping. Queries: `me`, `devices`, `device`, `latestPosition`, `geofences`, `alerts`, `billing`; mutation: `provisionDevice`. Client: **[`@fleet/sdk`](../../packages/sdk)**. |
| **MFA (TOTP)** | `POST /auth/mfa/setup\|enable\|disable` (authed) and `POST /auth/mfa/verify` (login step 2). RFC-6238 TOTP (`src/engine/totp.ts`, vector-tested). `login` returns `{mfaRequired,mfaToken}` when MFA is on; MFA tokens are rejected as API access tokens. |

## The closed loop

```
Provision device (POST /devices)
        │  DevicesService.provision
        ▼
Redis SET  ingest:allowed_imeis  ◄─── ingestion RedisAllowList.isAllowed (cached)
        ▲                                     │
        │                              device now accepted, sends AVL
Telemetry stream (Redis/Kafka) ◄──────────────┘  ingestion StreamBusSink
        │  TelemetryConsumer
        ▼
Postgres/PostGIS + Timescale  +  Redis hot state
        │
        ▼
GET /devices/:id/latest | /history   (live map + playback)
```

## Run

```bash
# in-memory (no infra) — great for local dev and the tests
USE_IN_MEMORY=true JWT_SECRET=dev npm start

# with real infra
DATABASE_URL=postgres://postgres:fleet@localhost:5432/fleet \
REDIS_URL=redis://localhost:6379 JWT_SECRET=secret npm start
```

Or bring up the **entire stack** (DB+PostGIS+Timescale, Redis, ingestion,
control-plane) from the repo root:

```bash
docker compose up --build
```

## Test

```bash
npm test   # tsc build + node --test on the compiled output (16 tests)
```

This is a real NestJS app: **CommonJS + `tsc` build + decorators/DI** — a
deliberate contrast with the ESM-native, no-build ingestion tier (NestJS's DI
needs `emitDecoratorMetadata`, which Node's native TS runner does not emit).

### Production hardening

- **Rate limiting** — per-IP (`@nestjs/throttler`), `THROTTLE_LIMIT` / `THROTTLE_TTL_MS`; exceeding it returns 429. The throttler guard runs before auth.
- **OpenAPI/Swagger** — interactive docs at **`/docs`**, spec at **`/openapi.json`**.
- **Security headers** — helmet; `x-powered-by` removed.
- **Consistent errors** — every error is `{ statusCode, error, message, requestId, path, timestamp }`; 500s never leak internals.
- **Request tracing** — an `x-request-id` on every response (echoes an inbound one) + one-line access logs.
- **CORS** — restricted to `CORS_ORIGINS` (csv), or reflect-any in dev.

All applied via `applyHttpHardening()` (used by `main.ts`, the demo server, and the e2e tests) — see `src/hardening.ts` and `src/common/http.ts`. CI is in `.github/workflows/ci.yml`.

### Real-infrastructure integration tests

The in-memory suite proves the logic; a separate suite proves the actual
PostgreSQL/PostGIS/TimescaleDB SQL (skipped unless `DATABASE_URL` is set):

```bash
docker compose up -d db redis            # from repo root; DB on host port 5433
DATABASE_URL=postgres://postgres:fleet@localhost:5433/fleet npm run test:pg
```

Covers every pg repository against real infra: tenant/user/device CRUD, the
position **PostGIS geography round-trip** (lat/lon via `ST_MakePoint`/`ST_Y`/
`ST_X`, `ON CONFLICT` dedup), geofence **WKT/GeoJSON** circle+polygon round-trip,
alerts, trips, and config upsert. Running this against a live TimescaleDB caught
three bugs the in-memory path hid: a migration compression/RLS incompatibility,
`timestamptz` returning `Date` instead of ISO strings, and a partial-config
update sending `NULL` into `NOT NULL` columns.

## Persistence seam

All data access is behind repository interfaces (`src/domain/repository.ts`):

- **In-memory** (`in-memory.repository.ts`) — tests + local dev, zero infra.
- **PostgreSQL/PostGIS/Timescale** (`pg.repository.ts`) — production; parameterized
  SQL, `geography(Point,4326)`, multi-row idempotent inserts. Schema in
  `migrations/001_init.sql` (hypertable, GiST index, compression/retention, RLS).

The real spatial/time-series layer is **integration-tested via docker-compose**,
not in the in-process suite (the CI sandbox has no PostGIS). The API, auth,
allow-list sync, and consumer logic are all fully covered here.

## Deliberately deferred

Sub-orgs/departments, user-management endpoints (only tenant-admin bootstrap
today), SSO/MFA, geofencing/alerts/reports (separate worker services per the
roadmap), and GraphQL (REST-first for this slice).
