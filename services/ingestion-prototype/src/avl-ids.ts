/**
 * FTC927 AVL ID map (firmware 3.0.7+), transcribed from the vendor page
 * "FTC927 Teltonika Data Sending Parameters ID". This is the deterministic
 * raw-record -> domain-field mapping the ingestion layer applies. Only the
 * fields the platform acts on day one are listed; the full table is large and
 * lives in configuration, not code.
 */
export interface AvlSpec {
  name: string;
  unit?: string;
  /** transform raw integer to a domain value */
  scale?: (raw: number | bigint) => number;
}

const mV = (raw: number | bigint) => Number(raw); // already millivolts
const identity = (raw: number | bigint) => Number(raw);

export const FTC927_AVL: Record<number, AvlSpec> = {
  1: { name: 'digitalInput1' },
  9: { name: 'analogInput1', unit: 'V', scale: (r) => Number(r) * 0.001 },
  16: { name: 'totalOdometer', unit: 'm', scale: identity },
  17: { name: 'accelX', unit: 'mg', scale: identity },
  18: { name: 'accelY', unit: 'mg', scale: identity },
  19: { name: 'accelZ', unit: 'mg', scale: identity },
  21: { name: 'gsmSignal', scale: identity }, // 0..5
  67: { name: 'batteryVoltage', unit: 'mV', scale: mV },
  68: { name: 'batteryCurrent', unit: 'mA', scale: mV },
  69: { name: 'gnssStatus', scale: identity }, // 0 off,1 fix,2 no-fix,3 sleep
  113: { name: 'batteryLevel', unit: '%', scale: identity },
  179: { name: 'digitalOutput1' },
  181: { name: 'gnssPdop', scale: identity },
  182: { name: 'gnssHdop', scale: identity },
  199: { name: 'tripOdometer', unit: 'm', scale: identity },
  200: { name: 'sleepMode', scale: identity },
  237: { name: 'networkType', scale: identity }, // 0 3G,1 GSM,2 4G,3 CATM1,4 NB1
  239: { name: 'ignition', scale: identity }, // 0 off, 1 on
  240: { name: 'movement', scale: identity }, // 0 off, 1 on
  241: { name: 'gsmOperator', scale: identity },
  449: { name: 'ignitionOnCounter', unit: 's', scale: identity },
  641: { name: 'iccid' },
  800: { name: 'externalVoltage', unit: 'mV', scale: mV },
  1148: { name: 'connectivityQuality', unit: 'dBm', scale: identity },
  1433: { name: 'deadReckoningStatus', scale: identity },
};

export interface MappedTelemetry {
  [field: string]: number | undefined;
}

export function mapIo(values: Record<number, number | bigint>): MappedTelemetry {
  const out: MappedTelemetry = {};
  for (const [idStr, raw] of Object.entries(values)) {
    const spec = FTC927_AVL[Number(idStr)];
    if (!spec) continue; // unknown IDs are kept raw elsewhere, not dropped
    out[spec.name] = spec.scale ? spec.scale(raw) : Number(raw);
  }
  return out;
}
