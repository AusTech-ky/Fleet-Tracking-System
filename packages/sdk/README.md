# @fleet/sdk

A tiny, **zero-dependency, fully-typed** TypeScript client for the FleetView
API — REST login + the GraphQL surface. Works in Node 18+ and modern browsers
(uses global `fetch`).

## Usage

```ts
import { FleetClient } from '@fleet/sdk';

const fleet = new FleetClient({ baseUrl: 'https://api.fleetview.app' });
await fleet.login('me@acme.ky', 'password');   // stores the access token

const me = await fleet.me();
const devices = await fleet.devices();          // department-scoped, like the API
const pos = await fleet.latestPosition(devices[0].id);
const { planId, devicesUsed, limits } = await fleet.billing();

const device = await fleet.provisionDevice('860000000000001', 'FTC927');
```

Already have a token? `new FleetClient({ baseUrl, token })` or `fleet.setToken(t)`.

## Methods

| Method | Returns |
|---|---|
| `login(email, password)` | stores a token (throws `FleetApiError` on failure / MFA-required) |
| `me()` | current user + tenant |
| `devices()` / `device(id)` | scoped device(s) |
| `latestPosition(deviceId)` | last-known position (or `null`) |
| `geofences()` | tenant geofences |
| `alerts(deviceId?, limit?)` | recent alerts |
| `billing()` | plan, limits, usage |
| `provisionDevice(imei, model, departmentId?)` | the created device |

All GraphQL errors surface as `FleetApiError`. Inject a custom `fetch` via
`new FleetClient({ baseUrl, fetch })` for tests.

## Test

```bash
npm test   # runs against an in-process fake server; 5 tests
```

Also live-smoke-verified against the real control-plane GraphQL endpoint.

> A production build would typically **generate** this client from the GraphQL
> schema (e.g. graphql-codegen). This hand-written version keeps the SDK
> dependency-free and is kept in sync with the schema by its tests.
