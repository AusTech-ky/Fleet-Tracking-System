import type { AvlRecord } from '@fleet/protocol-teltonika';

/**
 * FTC927 AVL-ID -> canonical field mapping (firmware 3.0.7+), from the vendor
 * page "FTC927 Teltonika Data Sending Parameters ID". Unmapped IDs are NOT
 * dropped — they are preserved under `attrs` so we never lose data we don't yet
 * model. This is the Normalizer stage of the pipeline (ARCHITECTURE §4.2).
 */
interface Spec { name: string; scale?: (r: number) => number }
const id = (r: number) => r;

const FTC927: Record<number, Spec> = {
  1: { name: 'digitalInput1' },
  9: { name: 'analogInput1V', scale: (r) => r * 0.001 },
  16: { name: 'totalOdometerM' },
  17: { name: 'accelX' }, 18: { name: 'accelY' }, 19: { name: 'accelZ' },
  21: { name: 'gsmSignal' },
  66: { name: 'externalVoltageMv' }, // legacy 2-byte ext voltage id seen in Codec8 samples
  67: { name: 'batteryVoltageMv' },
  68: { name: 'batteryCurrentMa' },
  69: { name: 'gnssStatus' },
  113: { name: 'batteryLevelPct' },
  179: { name: 'digitalOutput1' },
  181: { name: 'gnssPdop' }, 182: { name: 'gnssHdop' },
  199: { name: 'tripOdometerM' },
  200: { name: 'sleepMode' },
  237: { name: 'networkType' },
  239: { name: 'ignition' },
  240: { name: 'movement' },
  241: { name: 'gsmOperator' },
  449: { name: 'ignitionOnCounterS' },
  800: { name: 'externalVoltageMv' },
  1148: { name: 'connectivityQuality' },
  1433: { name: 'deadReckoningStatus' },
};

export interface NormalizedTelemetry {
  imei: string;
  ts: string; // ISO8601
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number;
  speedKph: number;
  satellites: number;
  priority: number;
  eventId: number;
  fields: Record<string, number>; // mapped, named
  attrs: Record<string, number>; // unmapped raw AVL IDs (id -> value)
}

export function normalize(imei: string, rec: AvlRecord): NormalizedTelemetry {
  const fields: Record<string, number> = {};
  const attrs: Record<string, number> = {};
  for (const [idStr, raw] of Object.entries(rec.io.values)) {
    const n = Number(raw); // bigint (8-byte) collapses to number; full value kept in attrs if large
    const spec = FTC927[Number(idStr)];
    if (spec) fields[spec.name] = spec.scale ? spec.scale(n) : id(n);
    else attrs[idStr] = n;
  }
  return {
    imei,
    ts: rec.timestamp.toISOString(),
    latitude: rec.gps.latitude,
    longitude: rec.gps.longitude,
    altitude: rec.gps.altitude,
    heading: rec.gps.angle,
    speedKph: rec.gps.speed,
    satellites: rec.gps.satellites,
    priority: rec.priority,
    eventId: rec.io.eventId,
    fields,
    attrs,
  };
}
