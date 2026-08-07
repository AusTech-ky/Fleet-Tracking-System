# @fleet/ingestion — Production Teltonika Ingestion Service

The productionized device-facing ingest tier (see [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §4).
Consumes Teltonika FTC927 traffic and hands normalized telemetry to the durable
sink. Built on the shared [`@fleet/protocol-teltonika`](../../packages/protocol-teltonika)
codecs. **36 tests across the workspace pass; 17 in this service.**

## What it does

| Capability | Detail |
|---|---|
| **TCP + TLS** | Long-lived sockets, dual-stack bind, `0x01/0x00` IMEI handshake, allow-list auth. TLS via pre-provisioned device certs (optional mTLS). |
| **UDP** | Connectionless Codec 8/8E datagrams, echo-packet-id ack (no CRC — UDP frames). |
| **Codec 8 / 8E decode** | CRC-16/IBM verified; FTC927 AVL-ID → domain mapping; unmapped IDs preserved in `attrs`. |
| **Downlink (Codec 12)** | Send GPRS commands to a connected device by IMEI; await the device response. |
| **Idempotency** | Dedupe on `(imei, ts, payload-hash)` — in-memory or Redis (shared across nodes). |
| **Durable, ack-after-write** | WAL sink (always) + optional stream-bus sink; the device is acked **only after** the sink resolves. |
| **Observability** | Prometheus `/metrics`, `/healthz`, `/readyz` on a separate port. |
| **Graceful shutdown** | SIGTERM → stop accepting → drain sockets (configurable grace) → flush → exit. Unacked records resend on reconnect. |

## Run

```bash
# from repo root (installs the local workspaces, zero external deps)
npm install

# start (see .env.example for all settings)
cd services/ingestion
ALLOWED_IMEIS= TCP_PORT=5027 HTTP_PORT=9100 npm start
```

Node ≥ 22 runs the TypeScript directly — **no build step**. The service uses
`--experimental-transform-types` (wired into the npm scripts) because it relies
on TypeScript parameter-properties, which Node's strip-only mode rejects.

## Test

```bash
npm test          # this service (17 tests)
npm test -w ../.. # whole workspace (36 tests)
```

Protocol tests run against **Teltonika's own published vectors** (Codec 12
`getinfo` byte-for-byte, the UDP datagram example, TCP CRC `0xC7CF`). The e2e
tests drive real TCP/UDP sockets through the whole `App` — handshake, dedupe,
downlink round-trip, metrics, and graceful drain.

## Load-test with the device simulator

```bash
# with the service running on :5027
node --experimental-transform-types src/sim/device-sim.ts \
  --host=127.0.0.1 --port=5027 --devices=1000 --interval=10000
# then watch http://localhost:9100/metrics
```

Smoke-verified: 25 simulated devices → 125 acks, 0 decode errors, records mapped
and counted per-IMEI.

## Docker

```bash
docker build -t fleet/ingestion -f services/ingestion/Dockerfile .
docker run -p 5027:5027/tcp -p 5027:5027/udp -p 9100:9100 \
  -e ALLOWED_IMEIS=356307042441013 fleet/ingestion
```

## What's injected (production wiring)

The composition root (`src/app.ts`) injects external infra so the app is fully
testable in-process:

- **Deduper**: `InMemoryDeduper` (single node) or `RedisDeduper` (set `REDIS_URL`).
- **Sink**: `WalSink` always (DR fallback) + `StreamBusSink` when a `StreamProducer`
  (Kafka/Redpanda/Redis Stream) is provided. `CompositeSink` tees to both and only
  resolves — so the device is only acked — when **all** targets are durable.

## Deliberately out of scope (documented, not hidden)

- **Codec 16**: used only by FMB630/FM63XY (adds a Generation Type byte); the
  FTC927 does not use it. Detected and cleanly rejected; add via a new adapter
  when such hardware is onboarded (ARCHITECTURE §20).
- **DTLS** (UDP encryption): Node lacks a built-in DTLS server; needs a native
  lib. TLS-over-TCP is the secure path today.
- **Tachograph** (TBA file pull, Codec 12 file transfer): a separate slow-path
  worker, off the location hot path.
