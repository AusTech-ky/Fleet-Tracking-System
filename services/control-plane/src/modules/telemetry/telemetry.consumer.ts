import { Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  TOKENS,
  type DeviceRepository,
  type PositionRepository,
  type GeofenceRepository,
  type AlertRepository,
  type TripRepository,
  type AlertConfigRepository,
} from '../../domain/repository';
import type { HotState, RealtimePublisher, TelemetryBus, TelemetryMessage } from '../../integrations/ports';
import type { Position, Geofence, AlertConfig, AlertEvent } from '../../domain/entities';
import { DEFAULT_ALERT_CONFIG } from '../../domain/entities';
import { AlertEngine } from '../../engine/alerts';
import { TripDetector } from '../../engine/trips';
import { NotificationDispatcher } from '../../notifications/dispatcher';

/** Shape ingestion publishes (mirror of its NormalizedTelemetry). */
interface Normalized {
  imei: string;
  ts: string;
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number;
  speedKph: number;
  satellites: number;
  fields: Record<string, number>;
  attrs: Record<string, number>;
}

/**
 * Consumes the telemetry stream, persists positions, updates hot state, pushes
 * live updates, and runs the Phase-2 rules engine: per-position alert evaluation
 * (overspeed / ignition / geofence) and trip detection, plus a periodic
 * device-offline sweep. The engine instances hold per-device state across
 * batches; their logic is unit-tested in engine.test.ts.
 */
@Injectable()
export class TelemetryConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TelemetryConsumer.name);
  /**
   * IMEI → device lookup cache. Both hit kinds expire:
   *  - Negative (no device row *yet*): 10s. A tracker often transmits before
   *    the operator finishes provisioning it; a permanent `null` left it
   *    invisible until restart. Seen in production 2026-08-17.
   *  - Positive: 30s. A device's id never changes, but it can be soft-DELETED,
   *    and a lifetime cache kept attaching new positions to the deleted row.
   *    findByImei() only returns live devices, so a re-query notices within
   *    the TTL and telemetry for a deleted IMEI is dropped (and, at the edge,
   *    rejected by ingestion once the allow-list update lands).
   */
  private readonly imeiCache = new Map<string, { ref: { tenantId: string; deviceId: string } | null; expiresAt: number }>();
  private readonly NEGATIVE_CACHE_MS = 10_000;
  private readonly POSITIVE_CACHE_MS = 30_000;
  private readonly geofenceCache = new Map<string, { at: number; fences: Geofence[] }>();
  private readonly configCache = new Map<string, { at: number; config: AlertConfig }>();
  private readonly alertEngine = new AlertEngine(randomUUID);
  // Trip-detection thresholds are env-tunable (the demo uses a short stop time
  // so trips close quickly; production keeps the ~3 min default).
  private readonly tripDetector = new TripDetector(randomUUID, {
    stopMinSec: Number(process.env.TRIP_STOP_MIN_SEC ?? 180),
    moveSpeedKph: Number(process.env.TRIP_MOVE_SPEED_KPH ?? 5),
    stopSpeedKph: Number(process.env.TRIP_STOP_SPEED_KPH ?? 3),
  });
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly CACHE_TTL_MS = 15_000;

  constructor(
    @Inject(TOKENS.TelemetryBus) private readonly bus: TelemetryBus,
    @Inject(TOKENS.DeviceRepository) private readonly devices: DeviceRepository,
    @Inject(TOKENS.PositionRepository) private readonly positions: PositionRepository,
    @Inject(TOKENS.HotState) private readonly hot: HotState,
    @Inject(TOKENS.RealtimePublisher) private readonly realtime: RealtimePublisher,
    @Inject(TOKENS.GeofenceRepository) private readonly geofences: GeofenceRepository,
    @Inject(TOKENS.AlertRepository) private readonly alerts: AlertRepository,
    @Inject(TOKENS.TripRepository) private readonly trips: TripRepository,
    @Inject(TOKENS.AlertConfigRepository) private readonly alertConfig: AlertConfigRepository,
    @Inject(TOKENS.NotificationDispatcher) private readonly notifications: NotificationDispatcher,
  ) {}

  async onModuleInit() {
    await this.bus.start((batch) => this.process(batch));
    // Periodic device-offline sweep (uses default threshold; per-device tenant
    // is carried on each emitted alert).
    this.sweepTimer = setInterval(() => void this.runOfflineSweep(), 30_000);
  }
  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  async process(batch: TelemetryMessage[]): Promise<void> {
    const toInsert: Position[] = [];
    const latestPerDevice = new Map<string, Position>();
    const now = Date.now();

    for (const msg of batch) {
      const ref = await this.resolveDevice(msg.imei);
      if (!ref) {
        this.log.warn(`telemetry for unknown IMEI ${msg.imei} — skipped`);
        continue;
      }
      let n: Normalized;
      try {
        n = JSON.parse(msg.data) as Normalized;
      } catch {
        this.log.warn(`unparseable telemetry payload for ${msg.imei}`);
        continue;
      }
      const pos = this.toPosition(ref.tenantId, ref.deviceId, n);
      toInsert.push(pos);
      const prev = latestPerDevice.get(ref.deviceId);
      if (!prev || pos.ts > prev.ts) latestPerDevice.set(ref.deviceId, pos);

      // --- rules engine -------------------------------------------------
      const config = await this.configFor(ref.tenantId);
      const fences = await this.geofencesFor(ref.tenantId);
      const alertEvents = this.alertEngine.evaluate(pos, config, fences, now);
      if (alertEvents.length) {
        await this.alerts.insertMany(alertEvents);
        for (const a of alertEvents) {
          this.realtime.publishAlert(a.tenantId, a);
          this.dispatchNotification(a); // deliver via email/webhook (best-effort)
        }
      }
      const trip = this.tripDetector.update(pos);
      if (trip) await this.trips.insert(trip);
    }

    if (toInsert.length) await this.positions.insertMany(toInsert);
    for (const pos of latestPerDevice.values()) {
      await this.hot.setLast(pos);
      this.realtime.publish(pos.tenantId, pos);
    }
  }

  private async runOfflineSweep() {
    const offline = this.alertEngine.sweepOffline(Date.now(), DEFAULT_ALERT_CONFIG);
    if (!offline.length) return;
    await this.alerts.insertMany(offline);
    for (const a of offline) {
      this.realtime.publishAlert(a.tenantId, a);
      this.dispatchNotification(a);
    }
  }

  /** Best-effort external delivery; never blocks or fails the ingest path. */
  private dispatchNotification(alert: AlertEvent) {
    void this.notifications.dispatch(alert).catch((err) =>
      this.log.warn(`notification dispatch failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  private toPosition(tenantId: string, deviceId: string, n: Normalized): Position {
    const ign = n.fields.ignition;
    return {
      tenantId, deviceId, imei: n.imei, ts: n.ts,
      latitude: n.latitude, longitude: n.longitude, altitude: n.altitude,
      heading: n.heading, speedKph: n.speedKph, satellites: n.satellites,
      ignition: ign === undefined ? null : ign === 1, attrs: n.attrs ?? {},
    };
  }

  /**
   * Drop the cached IMEI → device mapping now, rather than waiting out the
   * TTL. Called when a device is soft-deleted (or its IMEI otherwise stops
   * being valid) so telemetry stops attaching to it immediately.
   */
  forgetImei(imei: string) {
    this.imeiCache.delete(imei);
  }

  private async resolveDevice(imei: string) {
    const hit = this.imeiCache.get(imei);
    if (hit && Date.now() < hit.expiresAt) return hit.ref;
    const device = await this.devices.findByImei(imei);
    const ref = device ? { tenantId: device.tenantId, deviceId: device.id } : null;
    this.imeiCache.set(imei, {
      ref,
      expiresAt: Date.now() + (ref ? this.POSITIVE_CACHE_MS : this.NEGATIVE_CACHE_MS),
    });
    return ref;
  }

  private async geofencesFor(tenantId: string): Promise<Geofence[]> {
    const hit = this.geofenceCache.get(tenantId);
    if (hit && Date.now() - hit.at < this.CACHE_TTL_MS) return hit.fences;
    const fences = await this.geofences.list(tenantId);
    this.geofenceCache.set(tenantId, { at: Date.now(), fences });
    return fences;
  }

  private async configFor(tenantId: string): Promise<AlertConfig> {
    const hit = this.configCache.get(tenantId);
    if (hit && Date.now() - hit.at < this.CACHE_TTL_MS) return hit.config;
    const config = await this.alertConfig.get(tenantId);
    this.configCache.set(tenantId, { at: Date.now(), config });
    return config;
  }
}
