import type { Position, AlertEvent } from '../domain/entities';

/**
 * Publishes the IMEI allow-list to a shared store the ingestion tier reads for
 * device authentication. This closes the loop: provisioning a device here makes
 * ingestion accept it, with no redeploy (ARCHITECTURE §4, §8).
 */
export interface AllowListPublisher {
  /** Replace the whole allow-list (used on boot / full resync). */
  replaceAll(imeis: string[]): Promise<void>;
  add(imei: string): Promise<void>;
  remove(imei: string): Promise<void>;
}

/** A batch of telemetry messages read from the stream bus. */
export interface TelemetryMessage {
  imei: string;
  ts: string;
  data: string; // JSON of NormalizedTelemetry
}

/**
 * Consumes the telemetry stream that ingestion produces. Implementations pull
 * batches and invoke the handler; the consumer service persists + updates hot
 * state, then the implementation advances its offset (at-least-once).
 */
export interface TelemetryBus {
  start(handler: (batch: TelemetryMessage[]) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

/** Hot last-known state, read by the live map (never hits the cold store). */
export interface HotState {
  setLast(p: Position): Promise<void>;
  getLast(tenantId: string, deviceId: string): Promise<Position | null>;
}

/**
 * Downlink: send a GPRS (Codec 12) command to a device over the socket it is
 * currently reporting on, and return its text reply. Implemented by an HTTP
 * client to the ingestion service's internal /commands endpoint. Throws a
 * DeviceCommandError with a `code` the API can map to a status.
 */
export interface DeviceCommander {
  send(imei: string, command: string): Promise<string>;
}
export type DeviceCommandErrorCode = 'not_connected' | 'timeout' | 'disabled' | 'unavailable' | 'rejected';
export class DeviceCommandError extends Error {
  constructor(public readonly code: DeviceCommandErrorCode, message: string) {
    super(message);
    this.name = 'DeviceCommandError';
  }
}

/**
 * Pushes live position updates to connected clients (the live map). Fan-out is
 * tenant-scoped. In-process here; multi-node would bridge via Redis pub/sub.
 */
export interface RealtimePublisher {
  publish(tenantId: string, position: Position): void;
  publishAlert(tenantId: string, alert: AlertEvent): void;
}
