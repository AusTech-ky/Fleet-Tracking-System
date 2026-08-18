/**
 * Builds the Teltonika `setdigout` command that engages or releases the relay
 * wired to a vehicle's starter/fuel circuit, and holds the safety reasoning in
 * one pure, tested place.
 *
 * Syntax (FTC927 SMS/GPRS Command List):
 *   setdigout <states> <T1> <T2> <T3> <S1> <S2> <S3>
 *   - <states>: one digit per DOUT — '1' HIGH, '0' LOW, '?' leave unchanged.
 *   - <Sn>: per-DOUT SPEED THRESHOLD (km/h). The DOUT only activates while the
 *     device's speed is below it — the device-side guard against cutting a
 *     moving vehicle. 0 disables the guard, which we never do for immobilize.
 * We drive one DOUT and leave the rest untouched with '?'.
 *   https://wiki.teltonika-gps.com/view/FTC927_SMS/GPRS_Command_List
 */

export interface ImmobilizerWiring {
  /** which DOUT drives the relay, 1..4 */
  dout: number;
  /** true = DOUT HIGH cuts the circuit; false = DOUT HIGH allows it */
  activeHigh: boolean;
  /** device-side speed ceiling for engaging, km/h */
  maxEngageKph: number;
}

export class ImmobilizerCommandError extends Error {}

/** The DOUT level ('1'/'0') that produces the desired immobilized state. */
function levelFor(immobilize: boolean, activeHigh: boolean): '1' | '0' {
  // immobilize && activeHigh → HIGH; immobilize && !activeHigh → LOW; and inverse.
  return immobilize === activeHigh ? '1' : '0';
}

/** '?' for every DOUT except `dout` (1-indexed), which gets `level`. 4 DOUTs max. */
function stateString(dout: number, level: '1' | '0'): string {
  if (!Number.isInteger(dout) || dout < 1 || dout > 4) throw new ImmobilizerCommandError(`dout must be 1..4, got ${dout}`);
  return Array.from({ length: 4 }, (_, i) => (i + 1 === dout ? level : '?')).join('');
}

/**
 * Build the setdigout command.
 *  - immobilize=true engages the relay, but only below the speed threshold
 *    (both device-side via <Sn> and — caller's job — checked against last speed).
 *  - immobilize=false releases it unconditionally (threshold 0 = no speed gate,
 *    because letting a driver regain the engine must never be blocked).
 */
export function buildSetDigout(immobilize: boolean, wiring: ImmobilizerWiring): string {
  const level = levelFor(immobilize, wiring.activeHigh);
  const states = stateString(wiring.dout, level);
  // Per-DOUT timeout T (0 = latch until changed) and speed threshold S.
  const timeouts = Array.from({ length: 4 }, (_, i) => (i + 1 === wiring.dout ? '0' : '?'));
  const speed = immobilize ? Math.max(1, Math.min(50, Math.round(wiring.maxEngageKph))) : 0;
  const speeds = Array.from({ length: 4 }, (_, i) => (i + 1 === wiring.dout ? String(speed) : '?'));
  return `setdigout ${states} ${timeouts.join(' ')} ${speeds.join(' ')}`.replace(/\s+/g, ' ').trim();
}

/** Command to read the DOUTs back, to confirm the relay actually changed. */
export const GET_IO = 'getio';

export class ImmobilizeUnsafeError extends Error {}

/**
 * Refuse to immobilize a vehicle that is (or might be) moving. Belongs to the
 * caller in addition to the device-side threshold, because the safest cut is
 * one that never leaves our server if the car is on the move.
 */
export function assertSafeToImmobilize(lastSpeedKph: number | null, maxEngageKph: number): void {
  if (lastSpeedKph !== null && lastSpeedKph > maxEngageKph) {
    throw new ImmobilizeUnsafeError(
      `Vehicle is moving (${lastSpeedKph} km/h). Immobilizing is only allowed at or below ${maxEngageKph} km/h.`,
    );
  }
}
