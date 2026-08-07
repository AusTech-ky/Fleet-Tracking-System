# Deployment runbook

How to put FleetView on a public host so real Teltonika FTC927 devices can
connect. Two paths:

- **[Single host (Docker)](#single-host-docker)** — recommended to start.
  Verified working end-to-end; handles thousands of devices on one VM.
- **[Kubernetes](#kubernetes-scale-out)** — for scale-out/HA later.

---

## The one thing to get right

Your deployment carries **two different kinds of traffic**:

```
Browsers  ──HTTPS / WSS :443──►  caddy ──► web + control-plane
Devices   ──raw TCP :5027─────►  ingestion
```

Teltonika trackers speak a **binary protocol over a raw TCP socket** — not
HTTP. They cannot go through an HTTPS reverse proxy, a CDN, or an
HTTP-only load balancer. Port **5027/tcp must be open directly to the
ingestion service**. This is the most common way a tracking deployment fails.

---

## Single host (Docker)

### 1. Provision a VM

| Devices | vCPU | RAM | Disk |
|---|---|---|---|
| ≤ 500 | 2 | 4 GB | 40 GB SSD |
| ≤ 5,000 | 4 | 8 GB | 100 GB SSD |
| ≤ 20,000 | 8 | 16 GB | 250 GB SSD |

Any provider works (AWS EC2/Lightsail, DigitalOcean, Hetzner, Vultr).
Install Docker Engine + the Compose plugin.

Position data dominates disk. Timescale compresses chunks older than 7 days
and drops raw positions after 400 days (both configurable in `001_init.sql`).

### 2. DNS

Point two A-records at the VM's public IP:

```
fleet.example.com       →  <VM_IP>     # web app
api.fleet.example.com   →  <VM_IP>     # API / WebSocket / GraphQL
```

Devices connect by **IP or hostname** — a third record (e.g.
`gps.example.com`) is optional but makes it possible to move the ingestion
host later without reconfiguring every device.

### 3. Firewall

Open **inbound**:

| Port | Proto | Who | Why |
|---|---|---|---|
| 80 | TCP | world | Let's Encrypt HTTP challenge + redirect |
| 443 | TCP | world | web app + API + WebSocket |
| **5027** | **TCP** | **world** | **device ingestion — the critical one** |
| 22 | TCP | your IP only | SSH |

Do **not** expose 5432 (Postgres), 6379 (Redis) or 9100 (metrics).
The compose file already keeps those on the internal Docker network.

> Cloud-specific: on AWS this is a Security Group rule; a classic ALB will
> **not** forward 5027 (it's HTTP-only) — use an NLB or point devices straight
> at the instance IP.

### 4. Configure and start

```bash
git clone <your-repo> fleetview && cd fleetview
cp .env.prod.example .env
# Edit .env: APP_DOMAIN, API_DOMAIN, ACME_EMAIL, and generate secrets:
#   openssl rand -hex 32
nano .env

docker compose -f docker-compose.prod.yml up -d --build
```

Caddy obtains TLS certificates automatically once DNS resolves. Check:

```bash
docker compose -f docker-compose.prod.yml ps          # all healthy?
curl -s https://api.fleet.example.com/healthz          # {"status":"ok"}
```

> **Changing a domain later requires a rebuild of `web`** — `NEXT_PUBLIC_*`
> values are baked in at build time, not read at runtime.

### 5. Create your organization

Open `https://fleet.example.com`, choose **Create an organization**. That first
account is the tenant admin. (Then enable MFA under Settings → Security.)

### 6. Provision each device — *before* it connects

Ingestion only accepts IMEIs on its allow-list, which the control-plane
publishes to Redis when you provision. An unprovisioned device is rejected
with `0x00` and will retry forever.

Settings → or via API:

```bash
curl -X POST https://api.fleet.example.com/devices \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"imei":"860000000000001","model":"FTC927","name":"Delivery Van 1"}'
```

### 7. Configure the trackers

Using the **Teltonika Configurator** (or FOTA Web), per device:

| Setting | Param | Value |
|---|---|---|
| APN | 2001 | from your SIM provider |
| APN user / pass | 2002 / 2003 | if required |
| **Server domain/IP** | **2004** | `gps.example.com` or the VM IP |
| **Server port** | **2005** | `5027` |
| **Protocol** | **2006** | `0` (TCP) |
| Data protocol | — | **Codec 8 Extended** |

Then **reboot the device** — server settings only apply after a restart.

Optionally set a secondary server (2007–2010) in *Backup* mode for redundancy.
Ingestion deduplicates, so *Duplicate* mode is safe too.

### 8. Verify the first device

```bash
# Did it connect and authenticate?
docker compose -f docker-compose.prod.yml logs -f ingestion | grep -i imei
#   ... "msg":"imei accepted","imei":"8600000000000001"

# Are records landing?
curl -s https://api.fleet.example.com/devices/<DEVICE_ID>/latest \
  -H "authorization: Bearer $TOKEN"
```

Then watch it on the map. If the device connects but you see decode errors,
capture them — see [Troubleshooting](#troubleshooting).

---

## Operations

**Logs**
```bash
docker compose -f docker-compose.prod.yml logs -f ingestion
docker compose -f docker-compose.prod.yml logs -f control-plane
```

**Metrics** (Prometheus format, internal only — scrape or port-forward):
`ingest_active_connections`, `ingest_records_total`,
`ingest_decode_errors_total`, `ingest_duplicates_dropped_total`,
`ingest_ack_latency_seconds`.

```bash
docker compose -f docker-compose.prod.yml exec ingestion \
  node -e "fetch('http://127.0.0.1:9100/metrics').then(r=>r.text()).then(console.log)"
```

**Backups** — the database holds everything durable:
```bash
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U postgres fleet | gzip > fleet-$(date +%F).sql.gz
```
Schedule this daily and copy it off-host.

**Upgrades**
```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```
Rolling restart is safe: devices reconnect automatically and **re-send any
records that were not acked**, so no data is lost.

**Schema changes** — `001_init.sql` only runs on a *fresh* database. Every
later change is its own numbered file (`002_…`), applied to existing
databases with:
```bash
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -d fleet -f /docker-entrypoint-initdb.d/002_device_name.sql
```

**TLS for device traffic** (optional): put `server.key`/`server.crt` in
`./certs`, set `INGEST_TLS_ENABLED=true`, and upload the CA to each device via
the Configurator (*Upload user TLS certificate*). Devices without the cert will
stop connecting — roll it out device-by-device.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Device never appears in logs | Port 5027 blocked, wrong server IP/port on the device, or it wasn't rebooted after config |
| `imei rejected` in logs | Device not provisioned — add it in the app first |
| Connects, then disconnects repeatedly | Device didn't get a valid ack — check `ingest_decode_errors_total` and the WAL |
| `decode error` entries | Unexpected codec/firmware. The socket is dropped **without acking**, so the device keeps the data and resends — nothing is lost. Capture the log line and the device's firmware version |
| Map loads but no live updates | WebSocket blocked — ensure `wss://api.…` reaches Caddy (port 443) |
| Web app calls the wrong API | `NEXT_PUBLIC_*` is build-time — rebuild `web` after changing domains |

---

## Kubernetes (scale-out)

For multi-node/HA once one VM isn't enough. Manifests live in
[`infra/k8s`](../infra/k8s); AWS infrastructure in
[`infra/terraform`](../infra/terraform).

Key points the manifests encode:

- **Ingestion is exposed via a `LoadBalancer` Service of protocol TCP**
  (an NLB on AWS — *not* an ALB/Ingress, which are HTTP-only).
- Ingestion holds **long-lived sockets**, so it scales on connection count and
  needs a long `terminationGracePeriodSeconds` to drain.
- The control-plane is stateless and scales on CPU/RPS behind an Ingress.
- Postgres/Redis are **managed services** (RDS + ElastiCache), not pods.

> ⚠️ **Status: written, not run.** Unlike the Docker path above — which was
> verified end-to-end — these manifests have never been applied to a live
> cluster (none was available). Treat them as a reviewed starting point:
> `kubectl apply --dry-run=server` and a staging cluster first.
