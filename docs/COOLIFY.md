# Deploying FleetView on Coolify

The repo root `Dockerfile` builds the whole platform (web + API + device
ingestion) into one image. Postgres and Redis are separate Coolify resources.
Database migrations run automatically on every deploy.

> Prefer independent scaling? Use `docker-compose.prod.yml` or `infra/k8s/`
> instead — see [DEPLOYMENT.md](DEPLOYMENT.md). The all-in-one image is the
> simplest path and is well suited to a pilot fleet.

---

## 1. Postgres — must be PostGIS + TimescaleDB

⚠️ Coolify's default Postgres image **will not work**: FleetView needs the
PostGIS and TimescaleDB extensions.

Create a **PostgreSQL** resource and change the Docker image to:

```
timescale/timescaledb-ha:pg16
```

Set a strong password and note the connection string. Inside Coolify's network
it looks like:

```
postgres://postgres:<PASSWORD>@<service-name>:5432/fleet
```

Make sure the database is named `fleet` (or adjust the URL).

## 2. Redis

Create a **Redis** resource (the default image is fine). It carries the
telemetry stream, the device allow-list and hot last-known positions.

```
redis://<service-name>:6379
```

## 3. Application

**New Resource → Application → Public/Private Repository**

| Field | Value |
|---|---|
| Repository | `https://github.com/AusTech-ky/Fleet-Tracking-System` |
| Branch | `main` |
| Build Pack | **Dockerfile** |
| Dockerfile Location | `/Dockerfile` |
| Base Directory | `/` |

### Environment variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | from step 1 |
| `REDIS_URL` | from step 2 |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `CORS_ORIGINS` | `https://fleet.yourdomain.com` |
| `PORT` | `3000` (API) |
| `WEB_PORT` | `3001` (web) |
| `TCP_PORT` | `5027` (devices) |

### Build arguments — required, and easy to miss

The web app inlines its API URL **at build time**. Set these as *build*
variables (not just runtime), or the UI will call `localhost` in the browser:

| Build arg | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.yourdomain.com` |
| `NEXT_PUBLIC_WS_URL` | `wss://api.yourdomain.com` |

Changing a domain later means **rebuilding**, not just restarting.

## 4. Domains and ports — the important part

FleetView carries two kinds of traffic and Coolify configures them differently.

**HTTP (Coolify's proxy handles TLS):**

| Domain | Port |
|---|---|
| `https://fleet.yourdomain.com` | `3001` — web app |
| `https://api.yourdomain.com` | `3000` — API, WebSocket, GraphQL |

**Raw TCP — devices:**

Teltonika trackers speak a **binary protocol over a plain TCP socket**. They
cannot go through Coolify's HTTP proxy, a domain, or Cloudflare proxying. In the
application's **Network / Ports Mappings**, add:

```
5027:5027
```

Then open **TCP 5027** in your server's firewall (and cloud security group).
This is the single most common reason a tracker never appears.

## 5. First run

1. Deploy. Check the logs for `migrate: applied 001_init.sql` and the three
   `[start]` lines.
2. Open `https://fleet.yourdomain.com` → **Create an organization**.
3. Provision each device by IMEI *before* it connects — ingestion rejects
   unknown IMEIs.
4. Configure the trackers (server address, port `5027`, TCP, Codec 8 Extended)
   and reboot them — see [DEPLOYMENT.md §7](DEPLOYMENT.md#7-configure-the-trackers).

## 6. Verify

```bash
curl https://api.yourdomain.com/healthz        # {"status":"ok"}
```

In the application logs you should see, once a tracker dials in:

```
{"level":"info","msg":"imei accepted","imei":"8600000000000001"}
```

Then the vehicle appears on the map.

---

## Notes

- **Persistent storage:** add a volume mounted at `/wal` so the ingestion
  write-ahead buffer survives restarts. Without it, a restart mid-flight simply
  causes devices to re-send unacked records (nothing is lost, but the buffer
  starts empty).
- **Restart behaviour:** if any of the three processes exits, the container
  stops so Coolify restarts it. Devices reconnect automatically and re-send
  anything that was not acknowledged.
- **Health check path:** `/healthz` on port `3000`.
- **Scaling up:** when one container is no longer enough, move to
  `docker-compose.prod.yml` or the Kubernetes manifests, which run ingestion,
  API and web as separate, independently scalable services.
