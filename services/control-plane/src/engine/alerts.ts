import type { AlertConfig, AlertEvent, AlertType, Geofence, Position } from '../domain/entities';
import { geofencesContaining } from './geofence';

interface DeviceAlertState {
  deviceId: string;
  tenantId: string;
  imei: string;
  lastSeenMs: number;
  lastIgnition: boolean | null;
  overspeedActive: boolean; // fire once per over-limit episode, not every packet
  insideGeofences: Set<string>;
  offlineAlerted: boolean;
}

/**
 * Stateful, per-device alert evaluation. `evaluate` runs on every position and
 * emits alerts on *transitions* (crossing a speed limit, ignition flipping,
 * entering/leaving a geofence) — not on every packet — to avoid alert storms.
 * `sweepOffline` is called on a timer to flag devices that stopped reporting.
 * Pure except for the injected id/clock, so it is fully unit-testable.
 */
export class AlertEngine {
  private readonly state = new Map<string, DeviceAlertState>();
  constructor(private readonly newId: () => string) {}

  evaluate(pos: Position, config: AlertConfig, geofences: Geofence[], nowMs: number): AlertEvent[] {
    const st = this.get(pos, nowMs);
    st.lastSeenMs = nowMs;
    st.offlineAlerted = false; // any packet means the device is back online
    const events: AlertEvent[] = [];
    const emit = (type: AlertType, message: string, meta: AlertEvent['meta'] = {}) =>
      events.push({ id: this.newId(), tenantId: pos.tenantId, deviceId: pos.deviceId, imei: pos.imei, type, ts: pos.ts, message, meta });

    // Overspeed (edge-triggered).
    if (config.overspeedKph != null) {
      const over = pos.speedKph > config.overspeedKph;
      if (over && !st.overspeedActive) {
        emit('overspeed', `Speed ${pos.speedKph} km/h exceeded limit ${config.overspeedKph} km/h`, {
          speedKph: pos.speedKph, limitKph: config.overspeedKph,
        });
      }
      st.overspeedActive = over;
    }

    // Ignition change.
    if (config.ignitionAlerts && pos.ignition !== null) {
      if (st.lastIgnition !== null && pos.ignition !== st.lastIgnition) {
        emit(pos.ignition ? 'ignition_on' : 'ignition_off', `Ignition ${pos.ignition ? 'on' : 'off'}`);
      }
      st.lastIgnition = pos.ignition;
    }

    // Geofence enter/exit.
    if (config.geofenceAlerts && geofences.length) {
      const nowInside = geofencesContaining(geofences, pos);
      const nameOf = (id: string) => geofences.find((g) => g.id === id)?.name ?? id;
      for (const id of nowInside) {
        if (!st.insideGeofences.has(id)) emit('geofence_enter', `Entered ${nameOf(id)}`, { geofenceId: id });
      }
      for (const id of st.insideGeofences) {
        if (!nowInside.has(id)) emit('geofence_exit', `Left ${nameOf(id)}`, { geofenceId: id });
      }
      st.insideGeofences = nowInside;
    }

    return events;
  }

  /** Flag devices whose last position is older than the offline threshold. */
  sweepOffline(nowMs: number, config: AlertConfig): AlertEvent[] {
    const events: AlertEvent[] = [];
    for (const st of this.state.values()) {
      if (!st.offlineAlerted && nowMs - st.lastSeenMs > config.offlineAfterSec * 1000) {
        st.offlineAlerted = true;
        events.push({
          id: this.newId(), tenantId: st.tenantId, deviceId: st.deviceId,
          imei: st.imei, type: 'device_offline', ts: new Date(nowMs).toISOString(),
          message: `No data for ${Math.round((nowMs - st.lastSeenMs) / 1000)}s`, meta: {},
        });
      }
    }
    return events;
  }

  private get(pos: Position, nowMs: number): DeviceAlertState {
    let st = this.state.get(pos.deviceId);
    if (!st) {
      st = {
        deviceId: pos.deviceId, tenantId: pos.tenantId, imei: pos.imei, lastSeenMs: nowMs,
        lastIgnition: null, overspeedActive: false, insideGeofences: new Set(), offlineAlerted: false,
      };
      this.state.set(pos.deviceId, st);
    }
    return st;
  }
}
