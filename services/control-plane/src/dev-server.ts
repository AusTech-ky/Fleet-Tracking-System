import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { applyHttpHardening } from './hardening';
import { loadConfig } from './config';
import { AuthService } from './modules/auth/auth.service';
import { DevicesService } from './modules/devices/devices.service';
import { GeofencesService } from './modules/geofences/geofences';
import { AlertsService } from './modules/alerts/alerts';
import { DepartmentsService } from './modules/departments/departments';
import { TOKENS } from './domain/repository';
import { DEFAULT_ALERT_CONFIG } from './domain/entities';
import type { InMemoryBus } from './integrations/in-memory';

/**
 * Demo / local-dev server. Boots the control-plane fully in-memory (no Postgres
 * or Redis), seeds a tenant + a handful of FTC927 devices around George Town,
 * and simulates them moving — pushing telemetry onto the in-memory bus so the
 * live map, history, and WebSocket feed all have real data to show.
 *
 *   npm run demo   →   http://localhost:3000   (login: demo@fleet.ky / password123)
 */
const START: Array<[string, number, number]> = [
  ['860000000000001', -81.383, 19.313],
  ['860000000000002', -81.375, 19.305],
  ['860000000000003', -81.395, 19.320],
  ['860000000000004', -81.368, 19.298],
];

async function bootstrap() {
  const log = new Logger('Demo');
  // Inherit process.env (so JWT_EXPIRES_IN, TRIP_STOP_MIN_SEC etc. can be tuned
  // when exercising the demo) but force in-memory mode and a default secret.
  const config = loadConfig({
    ...process.env,
    USE_IN_MEMORY: 'true',
    JWT_SECRET: process.env.JWT_SECRET ?? 'demo-secret',
    PORT: process.env.PORT ?? '3000',
  } as NodeJS.ProcessEnv);
  const app = await NestFactory.create(AppModule.forRoot(config), { logger: ['error', 'warn'] });
  applyHttpHardening(app, { corsOrigins: config.corsOrigins });
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(config.port);

  const auth = app.get(AuthService);
  const devices = app.get(DevicesService);
  const bus = app.get<InMemoryBus>(TOKENS.TelemetryBus);

  const { tenant } = await auth.registerTenant({
    tenantName: 'Cayman Demo Fleet',
    adminEmail: 'demo@fleet.ky',
    password: 'password123',
  });
  // A tenant-wide admin AuthUser for seeding.
  const adminUser = { userId: 'seed', tenantId: tenant.id, role: 'admin' as const, email: 'demo@fleet.ky', departmentId: null };

  // Seed two departments and spread devices across them.
  const depts = app.get(DepartmentsService);
  const north = await depts.create(tenant.id, { name: 'North District' });
  const south = await depts.create(tenant.id, { name: 'South District' });

  const NAMES = ['Delivery Van 1', 'Delivery Van 2', 'Pickup Truck A', 'Service Car 7'];
  const fleet: Array<{ imei: string; lat: number; lon: number; heading: number; stopFor: number }> = [];
  for (let i = 0; i < START.length; i++) {
    const [imei, lon, lat] = START[i];
    await devices.provision(adminUser, imei, 'FTC927', i % 2 === 0 ? north.id : south.id, NAMES[i]);
    fleet.push({ imei, lat, lon, heading: Math.floor(rnd() * 360), stopFor: 0 });
  }

  // Seed a geofence + a lower speed limit so the demo generates live alerts.
  await app.get(GeofencesService).create(tenant.id, {
    name: 'George Town CBD', kind: 'circle', centerLat: 19.3133, centerLon: -81.3833, radiusM: 1500,
  });
  await app.get(AlertsService).setConfig(tenant.id, { ...DEFAULT_ALERT_CONFIG, overspeedKph: 65 });

  // Simulate movement + telemetry every 2s. Also backfill a little history.
  const tick = () => {
    const batch = fleet.map((v) => {
      // Occasionally park the vehicle for a stretch so a trip closes (with the
      // short TRIP_STOP_MIN_SEC the demo sets, this produces trips every ~minute).
      if (v.stopFor <= 0 && rnd() < 0.06) v.stopFor = 8 + Math.floor(rnd() * 5);
      const stopped = v.stopFor > 0;
      if (stopped) v.stopFor -= 1;
      v.heading = (v.heading + (rnd() - 0.5) * 40 + 360) % 360;
      const speed = stopped ? 0 : 20 + Math.floor(rnd() * 60);
      const rad = (v.heading * Math.PI) / 180;
      if (!stopped) {
        v.lat += Math.cos(rad) * 0.0006;
        v.lon += Math.sin(rad) * 0.0006;
      }
      const ts = new Date().toISOString();
      return {
        imei: v.imei,
        ts,
        data: JSON.stringify({
          imei: v.imei, ts, latitude: round(v.lat), longitude: round(v.lon),
          altitude: 0, heading: Math.round(v.heading), speedKph: speed, satellites: 9,
          fields: { ignition: 1, externalVoltageMv: 12300 + Math.floor(rnd() * 400) }, attrs: {},
        }),
      };
    });
    void bus.push(batch);
  };
  for (let i = 0; i < 10; i++) tick(); // seed some history
  setInterval(tick, 2000);

  log.log(`Demo control-plane on http://localhost:${config.port}  (login: demo@fleet.ky / password123)`);
}

// Deterministic-ish PRNG seeded from pid so we don't depend on Math.random being allowed.
let seed = (process.pid % 9973) + 1;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function round(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('demo failed', err);
  process.exit(1);
});
