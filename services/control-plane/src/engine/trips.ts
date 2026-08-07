import type { Position, Trip } from '../domain/entities';
import { haversineMeters } from './geometry';

export interface TripDetectorOptions {
  moveSpeedKph: number; // speed at/above which a trip starts
  stopSpeedKph: number; // speed at/below which the vehicle counts as stopped
  stopMinSec: number; // stopped for at least this long ends the trip
}

const DEFAULTS: TripDetectorOptions = { moveSpeedKph: 5, stopSpeedKph: 3, stopMinSec: 180 };

interface TripState {
  mode: 'idle' | 'moving';
  startTs: string;
  lastLat: number;
  lastLon: number;
  distanceM: number;
  maxSpeedKph: number;
  points: number;
  stoppedSinceMs: number | null; // when the current stop began (ms)
}

/**
 * Per-device trip/stop detector. A trip is a period of continuous movement; it
 * ends once the vehicle has been stationary for `stopMinSec`. Stateful and
 * deterministic (uses device timestamps), so a fixed position sequence always
 * yields the same trips — fully unit-testable.
 */
export class TripDetector {
  private readonly state = new Map<string, TripState>();
  private readonly opts: TripDetectorOptions;
  constructor(private readonly newId: () => string, opts: Partial<TripDetectorOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Feed one position; returns a completed Trip if this position ended one. */
  update(pos: Position): Trip | null {
    const st = this.state.get(pos.deviceId);
    const tMs = Date.parse(pos.ts);

    if (!st || st.mode === 'idle') {
      if (pos.speedKph >= this.opts.moveSpeedKph) {
        this.state.set(pos.deviceId, {
          mode: 'moving', startTs: pos.ts, lastLat: pos.latitude, lastLon: pos.longitude,
          distanceM: 0, maxSpeedKph: pos.speedKph, points: 1, stoppedSinceMs: null,
        });
      } else if (!st) {
        this.state.set(pos.deviceId, {
          mode: 'idle', startTs: pos.ts, lastLat: pos.latitude, lastLon: pos.longitude,
          distanceM: 0, maxSpeedKph: 0, points: 0, stoppedSinceMs: null,
        });
      }
      return null;
    }

    // moving
    st.distanceM += haversineMeters(st.lastLat, st.lastLon, pos.latitude, pos.longitude);
    st.lastLat = pos.latitude;
    st.lastLon = pos.longitude;
    st.maxSpeedKph = Math.max(st.maxSpeedKph, pos.speedKph);
    st.points += 1;

    if (pos.speedKph <= this.opts.stopSpeedKph) {
      if (st.stoppedSinceMs === null) st.stoppedSinceMs = tMs;
      else if (tMs - st.stoppedSinceMs >= this.opts.stopMinSec * 1000) {
        const trip: Trip = {
          id: this.newId(), tenantId: pos.tenantId, deviceId: pos.deviceId,
          startTs: st.startTs, endTs: pos.ts, distanceM: Math.round(st.distanceM),
          maxSpeedKph: st.maxSpeedKph, points: st.points,
        };
        this.state.set(pos.deviceId, {
          mode: 'idle', startTs: pos.ts, lastLat: pos.latitude, lastLon: pos.longitude,
          distanceM: 0, maxSpeedKph: 0, points: 0, stoppedSinceMs: null,
        });
        return trip;
      }
    } else {
      st.stoppedSinceMs = null;
    }
    return null;
  }
}
