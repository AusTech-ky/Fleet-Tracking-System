import type Redis from 'ioredis';
import type { Position } from '../domain/entities';
import type { AllowListPublisher, HotState, TelemetryBus, TelemetryMessage } from './ports';

export const ALLOWLIST_KEY = 'ingest:allowed_imeis';
const HOT_PREFIX = 'hot:pos:';

/** Redis SET as the shared IMEI allow-list the ingestion tier reads. */
export class RedisAllowList implements AllowListPublisher {
  constructor(private readonly redis: Redis, private readonly key = ALLOWLIST_KEY) {}
  async replaceAll(imeis: string[]) {
    const tx = this.redis.multi().del(this.key);
    if (imeis.length) tx.sadd(this.key, ...imeis);
    await tx.exec();
  }
  async add(imei: string) {
    await this.redis.sadd(this.key, imei);
  }
  async remove(imei: string) {
    await this.redis.srem(this.key, imei);
  }
}

/** Redis string per device holding the last position JSON. */
export class RedisHotState implements HotState {
  constructor(private readonly redis: Redis, private readonly ttlSec = 86_400) {}
  async setLast(p: Position) {
    await this.redis.set(`${HOT_PREFIX}${p.tenantId}:${p.deviceId}`, JSON.stringify(p), 'EX', this.ttlSec);
  }
  async getLast(tenantId: string, deviceId: string) {
    const raw = await this.redis.get(`${HOT_PREFIX}${tenantId}:${deviceId}`);
    return raw ? (JSON.parse(raw) as Position) : null;
  }
}

/**
 * Redis Streams consumer group. Reads the `telemetry` stream ingestion writes
 * to, hands batches to the handler, then ACKs (at-least-once). Runs until stop.
 */
export class RedisStreamBus implements TelemetryBus {
  private running = false;
  constructor(
    private readonly redis: Redis,
    private readonly stream = 'telemetry',
    private readonly group = 'control-plane',
    private readonly consumer = `cp-${process.pid}`,
  ) {}

  async start(handler: (b: TelemetryMessage[]) => Promise<void>) {
    // Create the consumer group (idempotent).
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '$', 'MKSTREAM');
    } catch (err) {
      if (!String(err).includes('BUSYGROUP')) throw err;
    }
    this.running = true;
    void this.loop(handler);
  }

  private async loop(handler: (b: TelemetryMessage[]) => Promise<void>) {
    while (this.running) {
      const res = (await this.redis.xreadgroup(
        'GROUP', this.group, this.consumer, 'COUNT', 200, 'BLOCK', 2000, 'STREAMS', this.stream, '>',
      )) as [string, [string, string[]][]][] | null;
      if (!res) continue;
      for (const [, entries] of res) {
        const batch: TelemetryMessage[] = [];
        const ids: string[] = [];
        for (const [id, fields] of entries) {
          ids.push(id);
          const obj = fieldsToObject(fields);
          batch.push({ imei: obj.imei, ts: obj.ts, data: obj.data });
        }
        await handler(batch);
        if (ids.length) await this.redis.xack(this.stream, this.group, ...ids);
      }
    }
  }

  async stop() {
    this.running = false;
  }
}

function fieldsToObject(fields: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
  return o;
}
