import type { Device, Position } from './types';

/**
 * Vehicle motion state — the single source of truth for the colour a vehicle
 * shows on the map and in the sidebar. Both surfaces call this, so they can
 * never disagree about what a dot means.
 *
 *   moving    green   speed > 0
 *   stopped   yellow  speed 0, ignition ON  (idling, traffic, at a job)
 *   parked    red     speed 0, ignition OFF
 *   inactive  black   no report within INACTIVE_AFTER_SEC, or never reported,
 *                     or the device is suspended/retired
 *
 * Stopped vs parked is decided by ignition — that is exactly the signal the
 * FTC927 reports, and it's the line operators care about ("engine running while
 * not moving"). A device that has never sent a position is inactive, not
 * parked: we don't know where it is.
 */
export type MotionState = 'moving' | 'stopped' | 'parked' | 'inactive';

/** No fix for this long → the vehicle is treated as inactive. */
export const INACTIVE_AFTER_SEC = 10 * 60;

export function motionState(d: Device, pos: Position | undefined, now = Date.now()): MotionState {
  if (d.status === 'suspended' || d.status === 'retired') return 'inactive';
  if (!pos) return 'inactive';
  if ((now - Date.parse(pos.ts)) / 1000 > INACTIVE_AFTER_SEC) return 'inactive';
  if (pos.speedKph > 0) return 'moving';
  if (pos.ignition === true) return 'stopped';
  return 'parked';
}

/** Hex colours, for the map (MapLibre markers can't read Tailwind classes). */
export const MOTION_HEX: Record<MotionState, string> = {
  moving: '#16a34a',   // green-600
  stopped: '#eab308',  // yellow-500
  parked: '#dc2626',   // red-600
  inactive: '#111827', // gray-900 (black)
};

/** Tailwind background classes, for the sidebar. Same palette as MOTION_HEX. */
export const MOTION_BG: Record<MotionState, string> = {
  moving: 'bg-green-600',
  stopped: 'bg-yellow-500',
  parked: 'bg-red-600',
  inactive: 'bg-gray-900 dark:bg-gray-300',
};

export const MOTION_LABEL: Record<MotionState, string> = {
  moving: 'Moving',
  stopped: 'Stopped',
  parked: 'Parked',
  inactive: 'Inactive',
};

/** Human hint for a tooltip: "Moving · 51 km/h", "Parked · 3 min ago". */
export function motionHint(state: MotionState, pos: Position | undefined, relative: (iso: string) => string): string {
  if (state === 'moving' && pos) return `${MOTION_LABEL.moving} · ${pos.speedKph} km/h`;
  if (state === 'inactive') return pos ? `${MOTION_LABEL.inactive} · last fix ${relative(pos.ts)}` : `${MOTION_LABEL.inactive} · no position yet`;
  return pos ? `${MOTION_LABEL[state]} · ${relative(pos.ts)}` : MOTION_LABEL[state];
}
