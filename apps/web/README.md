# @fleet/web — Live Map PWA (Next.js + MapLibre)

The first user-facing surface: sign in, see the fleet live on a map, click a
vehicle to replay its route. Consumes the control-plane REST API + the `/rt`
WebSocket feed. See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §3.

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript**
- **MapLibre GL** — WebGL vector map, provider-swappable via `NEXT_PUBLIC_MAP_STYLE`
- **TanStack Query** for REST server-state; a small WS hook for the live feed
- **Tailwind** + hand-rolled shadcn-style primitives (no UI-kit dependency)
- **PWA** manifest + theme color (installable)

## What works (verified end-to-end in a real browser)

- **Auth** — login / create-organization against `/auth/*`; JWT in `localStorage`;
  route guards redirect unauthenticated users to `/login`.
- **Live map** — one heading-rotated, ignition-colored marker per device;
  **markers move in real time** from the `/rt` WebSocket push (auto-reconnect
  with backoff). Header shows connection state + device/moving counts.
- **Device detail panel** — selecting a device opens a card over the map with
  live telemetry (speed, ignition, heading + compass, satellites, coordinates,
  relative "last seen" with a stale warning), **inline rename**, and camera
  actions: **Centre** (pan to it) and **Follow** (keep the camera locked on it
  as it moves). Selecting from the list also pans the map automatically.
- **Map controls** — basemap switcher plus **Fit all** to zoom out to the whole
  fleet.
- **Toasts** — every mutation (rename, group create, device move, geofence
  save/delete) reports success or the server's error message.
- **Responsive** — below `md` the device list becomes a slide-over drawer with a
  scrim (hamburger in the header); selecting a device closes it.
- **Device sidebar** — devices are organized into **collapsible groups** (backed
  by departments, so grouping and access-scoping share one model). Create a
  group inline (“+ New group”), move a device between groups from its card, and
  **search** by name / IMEI / model / status / group (multi-term, live counts;
  searching auto-expands groups and hides empty ones). Devices carry a friendly
  **name** (e.g. “Delivery Van 1”) with model+IMEI as secondary text.
- **Route playback + timeline scrubber** — click a vehicle → fetch 24h history →
  draw the route and drag/play a marker along it. (Scrubber verified animating.)
- **Geofences** — tenant geofences drawn as dashed zones on the map, plus a
  **drawing UI**: the Geofences panel lets you draw a **circle** (click centre →
  click edge) or **polygon** (click vertices → double-click to finish) directly
  on the map, name and save it, and list/delete existing zones. New geofences
  immediately feed the alert engine. (Verified end-to-end: circle + polygon
  drawn, saved, and deleted through the live backend.)
- **Alerts panel** — live alert feed (overspeed / ignition / geofence / offline)
  pushed over the same WebSocket, with a header badge count. (Verified: 51 alerts
  incl. live overspeed, panel + badge populated.)
- **Reports** (`/reports`) — pick a report (device summary, trips, speeding,
  geofence activity, or fleet roll-up), a device, and a date range → on-screen
  table + summary, with one-click **CSV / Excel / PDF** download. (Verified
  end-to-end: fleet report rendered, all three exports returned valid files.)
- **Settings** (`/settings`) — **Plan & usage** (current plan, device/user usage
  bars, one-click upgrade/downgrade), **Notifications** (webhook URLs + email
  recipients, signing secret, test-send), **Security** (TOTP MFA enroll/enable/
  disable), **Departments** (sub-org tree: create/delete, assign a parent), and
  **Team** (list/add users, change role, activate/deactivate, **assign a user to
  a department** to scope their access). A department-scoped user automatically
  sees only their subtree's devices on the map/list. (Verified: admin sees 4
  devices, a North-scoped operator sees 2.)
  The **login page** handles the MFA challenge (password → 6-digit code).
  (Verified end-to-end: config saved, user added, MFA enrolled + login challenge
  completed.)

Verified against the demo control-plane: 4 simulated FTC927s moving around George
Town, markers updating every 2s over the live socket, route rendered on select.

## Run it

```bash
# 1) start the demo backend (in-memory: no Postgres/Redis needed)
# Fake-data demo (offline UI work only). For real data use scripts/dev-live.ps1
cd ../../services/control-plane && npm run build && npm run demo:fake-data
#    → http://localhost:3000  (login: demo@fleet.ky / password123)

# 2) start the web app
cd ../../apps/web && npm install && npm run dev
#    → http://localhost:3000 ... use a different port if the API is on 3000:
#    npx next dev -p 3001
```

Then open the app, sign in with the demo credentials, and watch the fleet move.

## Configuration (build-time `NEXT_PUBLIC_*`)

| Var | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | control-plane REST base |
| `NEXT_PUBLIC_WS_URL` | derived from API URL | `/rt` WebSocket base |
| `NEXT_PUBLIC_DEFAULT_BASEMAP` | `streets` | initial basemap: `streets` / `satellite` / `hybrid` / `terrain` |

**Basemaps.** An on-map control (top-left) switches between **Streets**
(OpenStreetMap), **Satellite** (Esri World Imagery), **Hybrid** (imagery +
labels), and **Terrain** (Esri Topo) — all no-API-key raster providers, with
attribution wired in. Switching toggles layer visibility rather than swapping
the style, so geofences/routes/markers stay put. See `src/lib/basemaps.ts` to
add MapTiler/Mapbox/self-hosted providers.

> **Rendering note:** MapLibre's WebGL layers (basemap tiles, geofence fills,
> route line, playback dot) need a browser render loop; they don't paint in a
> headless/background tab (no `requestAnimationFrame`). All data, the marker
> layer, the basemap switcher, the alerts panel, and the scrubber are verified;
> the GL *painting* is only visible in a real, foregrounded browser.

## Build

```bash
npm run build   # typechecks + produces an optimized production build
```

## Deliberately deferred

Timeline scrubber for playback (currently draws the full route line), marker
clustering at low zoom (needed at 10k+ vehicles), geofence drawing, alerts UI,
and a device-provisioning screen (done via API today). The map provider is
abstracted so satellite/terrain/traffic layers slot in later.
