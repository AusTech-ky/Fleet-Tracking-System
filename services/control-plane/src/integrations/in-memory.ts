import type { Position } from '../domain/entities';
import type { AllowListPublisher, HotState, RealtimePublisher, TelemetryBus, TelemetryMessage } from './ports';

/** In-memory allow-list — used in tests and single-node local dev. */
export class InMemoryAllowList implements AllowListPublisher {
  readonly imeis = new Set<string>();
  async replaceAll(imeis: string[]) {
    this.imeis.clear();
    for (const i of imeis) this.imeis.add(i);
  }
  async add(imei: string) {
    this.imeis.add(imei);
  }
  async remove(imei: string) {
    this.imeis.delete(imei);
  }
}

/** Test/local bus: push messages programmatically; the handler is invoked. */
export class InMemoryBus implements TelemetryBus {
  private handler: ((b: TelemetryMessage[]) => Promise<void>) | null = null;
  async start(handler: (b: TelemetryMessage[]) => Promise<void>) {
    this.handler = handler;
  }
  async stop() {
    this.handler = null;
  }
  /** Simulate ingestion publishing a batch onto the stream. */
  async push(batch: TelemetryMessage[]) {
    if (!this.handler) throw new Error('bus not started');
    await this.handler(batch);
  }
}

/** Captures published updates; also lets a test subscribe. */
export class InMemoryRealtime implements RealtimePublisher {
  readonly published: { tenantId: string; position: Position }[] = [];
  readonly alerts: { tenantId: string; alert: import('../domain/entities').AlertEvent }[] = [];
  private subscribers: ((tenantId: string, p: Position) => void)[] = [];
  publish(tenantId: string, position: Position) {
    this.published.push({ tenantId, position });
    for (const s of this.subscribers) s(tenantId, position);
  }
  publishAlert(tenantId: string, alert: import('../domain/entities').AlertEvent) {
    this.alerts.push({ tenantId, alert });
  }
  onPublish(fn: (tenantId: string, p: Position) => void) {
    this.subscribers.push(fn);
  }
}

export class InMemoryHotState implements HotState {
  private map = new Map<string, Position>();
  private key(t: string, d: string) {
    return `${t}:${d}`;
  }
  async setLast(p: Position) {
    this.map.set(this.key(p.tenantId, p.deviceId), p);
  }
  async getLast(tenantId: string, deviceId: string) {
    return this.map.get(this.key(tenantId, deviceId)) ?? null;
  }
  /** Test hook: simulate a Redis restart / cold cache. */
  clear() {
    this.map.clear();
  }
}
