/**
 * Teltonika configuration parameters — the "records profile" (data acquisition)
 * settings that decide how often a tracker reports, and the GPRS command syntax
 * to read/write them over Codec 12.
 *
 * Every ID below is transcribed from the Teltonika Telematics Wiki "Parameter
 * list" page, section "Data acquisition mode parameters", together with the
 * FTC927 SMS/GPRS Command List page for the setparam/getparam syntax. Nothing
 * here is inferred: if an ID isn't on that page, it isn't here.
 *
 *   https://wiki.teltonika-gps.com/view/Parameter_list
 *   https://wiki.teltonika-gps.com/view/FTC927_SMS/GPRS_Command_List
 *   https://wiki.teltonika-gps.com/view/FTC927_Tracking_settings
 *
 * The device keeps six profiles — {Home, Roaming, Unknown network} × {On Stop,
 * Moving} — and switches between them automatically. Each profile has its own
 * acquisition thresholds; a record is created when ANY enabled threshold trips.
 * IDs are laid out at 50-ID strides, so the table is small and regular.
 */

export type NetworkMode = 'home' | 'roaming' | 'unknown';
export type MotionMode = 'stop' | 'moving';

/** Acquisition thresholds. Only the ones the wiki lists for each motion mode. */
export interface StopProfile {
  /** seconds; 0 disables time-based acquisition. Uint16 0..2592000, default 3600 */
  minPeriodSec: number;
  /** records to accumulate before a send. Uint8 1..255, default 1 */
  minSavedRecords: number;
  /** seconds between send attempts. Uint16 0..2592000, default 120 (home) */
  sendPeriodSec: number;
}
export interface MovingProfile extends StopProfile {
  /** metres; 0 disables. Uint16 0..65535, default 100 */
  minDistanceM: number;
  /** degrees; 0 disables. Uint8 0..180, default 10 */
  minAngleDeg: number;
  /** km/h; 0 disables. Uint8 0..100, default 10 */
  minSpeedDeltaKph: number;
}

/**
 * Base parameter ID for each (network, motion) profile. Field offsets within a
 * profile are constant:  +0 Min Period, +1 Min Distance, +2 Min Angle,
 * +3 Min Speed Delta, +4 Min Saved Records, +5 Send Period.
 * "On Stop" profiles only define +0, +4, +5 (no distance/angle/speed).
 */
export const PROFILE_BASE: Record<NetworkMode, Record<MotionMode, number>> = {
  home:    { stop: 10000, moving: 10050 },
  roaming: { stop: 10100, moving: 10150 },
  unknown: { stop: 10200, moving: 10250 },
};

const OFF = { minPeriodSec: 0, minDistanceM: 1, minAngleDeg: 2, minSpeedDeltaKph: 3, minSavedRecords: 4, sendPeriodSec: 5 } as const;

/** Value ranges, from the wiki table. Used to reject a bad value before it reaches a vehicle. */
export const PARAM_RANGE: Record<keyof MovingProfile, { min: number; max: number; unit: string }> = {
  minPeriodSec:     { min: 0, max: 2_592_000, unit: 's' },
  minDistanceM:     { min: 0, max: 65_535,    unit: 'm' },
  minAngleDeg:      { min: 0, max: 180,       unit: '°' },
  minSpeedDeltaKph: { min: 0, max: 100,       unit: 'km/h' },
  minSavedRecords:  { min: 1, max: 255,       unit: 'records' },
  sendPeriodSec:    { min: 0, max: 2_592_000, unit: 's' },
};

/** Parameter ID for one field of one profile. */
export function paramId(net: NetworkMode, motion: MotionMode, field: keyof MovingProfile): number {
  if (motion === 'stop' && (field === 'minDistanceM' || field === 'minAngleDeg' || field === 'minSpeedDeltaKph')) {
    throw new RangeError(`"${field}" does not exist on the On-Stop profile`);
  }
  return PROFILE_BASE[net][motion] + OFF[field];
}

/** All parameter IDs for a profile, in a stable order (for getparam). */
export function profileParamIds(net: NetworkMode, motion: MotionMode): Array<{ id: number; field: keyof MovingProfile }> {
  const fields: Array<keyof MovingProfile> = motion === 'moving'
    ? ['minPeriodSec', 'minDistanceM', 'minAngleDeg', 'minSpeedDeltaKph', 'minSavedRecords', 'sendPeriodSec']
    : ['minPeriodSec', 'minSavedRecords', 'sendPeriodSec'];
  return fields.map((field) => ({ id: paramId(net, motion, field), field }));
}

export class ParamValueError extends RangeError {}

/** Throw if any value is outside the wiki's documented range for that field. */
export function validateProfile(motion: MotionMode, values: Partial<MovingProfile>): void {
  for (const [k, v] of Object.entries(values) as Array<[keyof MovingProfile, number | undefined]>) {
    if (v === undefined) continue;
    if (!Number.isInteger(v)) throw new ParamValueError(`${k} must be an integer, got ${v}`);
    const r = PARAM_RANGE[k];
    if (v < r.min || v > r.max) throw new ParamValueError(`${k} must be ${r.min}..${r.max} ${r.unit}, got ${v}`);
    if (motion === 'stop' && (k === 'minDistanceM' || k === 'minAngleDeg' || k === 'minSpeedDeltaKph')) {
      throw new ParamValueError(`${k} is not a setting of the On-Stop profile`);
    }
  }
}

/**
 * Build the GPRS `setparam` command for a partial profile update.
 * Wiki syntax:  setparam <id>:<value>;<id>:<value>;...
 * GPRS (Codec 12) form carries no password and no leading space.
 */
export function buildSetParam(net: NetworkMode, motion: MotionMode, values: Partial<MovingProfile>): string {
  validateProfile(motion, values);
  const parts = (Object.entries(values) as Array<[keyof MovingProfile, number | undefined]>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${paramId(net, motion, k)}:${v}`);
  if (parts.length === 0) throw new ParamValueError('nothing to set');
  return `setparam ${parts.join(';')}`;
}

/** Build the GPRS `getparam` command to read a whole profile back. */
export function buildGetParam(net: NetworkMode, motion: MotionMode): string {
  return `getparam ${profileParamIds(net, motion).map((p) => p.id).join(';')}`;
}

/**
 * Parse a getparam response into field values. Device replies with
 * "Param ID:<id> Val:<value>;..." style text; we tolerate either "id:value"
 * or "Param ID:id Val:value" tokens and ignore anything we don't recognise.
 * Returns only the fields that were present in the reply.
 */
export function parseGetParamResponse(net: NetworkMode, motion: MotionMode, text: string): Partial<MovingProfile> {
  const byId = new Map(profileParamIds(net, motion).map((p) => [p.id, p.field]));
  const out: Partial<MovingProfile> = {};
  const re = /(?:Param ID:\s*)?(\d{4,5})\s*(?::|Val:)\s*(-?\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const field = byId.get(Number(m[1]));
    if (field) out[field] = Number(m[2]);
  }
  return out;
}

/** True when the device's setparam reply indicates success. */
export function setParamAccepted(reply: string): boolean {
  // Teltonika replies e.g. "New value 10050:5 was successfully applied" or
  // "Param ID:10050 New Val:5" — both contain no "error"/"fail". Be strict on
  // the negative rather than trusting a positive phrase we might mis-guess.
  return !/error|fail|invalid|unknown/i.test(reply);
}
