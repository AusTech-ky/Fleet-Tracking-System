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
 * Pushes live position updates to connected clients (the live map). Fan-out is
 * tenant-scoped. In-process here; multi-node would bridge via Redis pub/sub.
 */
export interface RealtimePublisher {
  publish(tenantId: string, position: Position): void;
  publishAlert(tenantId: string, alert: AlertEvent): void;
}
