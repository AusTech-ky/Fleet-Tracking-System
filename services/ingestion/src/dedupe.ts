import { createHash } from 'node:crypto';
import type { AvlRecord } from '@fleet/protocol-teltonika';

/**
 * Idempotency. Duplicate secondary-server mode and reconnect-resend both cause
 * the same record to arrive more than once (ARCHITECTURE §4.2). The dedupe key
 * is (imei, record-timestamp, payload-hash) so identical records collapse but
 * two genuinely distinct records at the same instant do not.
 */
export function dedupeKey(imei: string, rec: AvlRecord): string {
  const h = createHash('sha1');
  h.update(imei);
  h.update(String(rec.timestamp.getTime()));
  h.update(String(rec.priority));
  h.update(`${rec.gps.latitude},${rec.gps.longitude},${rec.gps.speed},${rec.gps.angle}`);
  h.update(rec.io.eventId.toString());
  for (const [k, v] of Object.entries(rec.io.values).sort()) h.update(`${k}=${v}`);
  return `${imei}:${rec.timestamp.getTime()}:${h.digest('hex').slice(0, 16)}`;
}

export interface Deduper {
  /** returns true if this key is NEW (should be processed), false if duplicate */
  checkAndSet(key: string): Promise<boolean>;
}

/**
 * In-memory TTL deduper. Correct for a single ingest node; for a multi-node
 * fleet where a device may reconnect to a different node, use RedisDeduper so
 * the dedupe set is shared. Bounded by maxEntries (LRU-ish eviction by age).
 */
export class InMemoryDeduper implements Deduper {
  private seen = new Map<string, number>(); // key -> expiry ms
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1_000_000,
    private readonly now: () => number = () => Date.now(),
  ) {}
  async checkAndSet(key: string): Promise<boolean> {
    const t = this.now();
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > t) return false; // duplicate, still valid
    this.seen.set(key, t + this.ttlMs);
    if (this.seen.size > this.maxEntries) this.evict(t);
    return true;
  }
  private evict(t: number) {
    for (const [k, exp] of this.seen) {
      if (exp <= t) this.seen.delete(k);
      if (this.seen.size <= this.maxEntries * 0.9) break;
    }
    // if still over (all live), drop oldest-inserted
    while (this.seen.size > this.maxEntries) {
      const first = this.seen.keys().next().value;
      if (first === undefined) break;
      this.seen.delete(first);
    }
  }
}

/** Minimal Redis client surface we depend on (satisfied by ioredis/node-redis). */
export interface RedisLike {
  set(key: string, val: string, mode: 'NX', ex: 'EX', ttl: number): Promise<string | null>;
}

/** Shared dedupe across ingest nodes. SET key NX EX ttl -> null means it existed. */
export class RedisDeduper implements Deduper {
  constructor(private readonly redis: RedisLike, private readonly ttlSeconds: number, private readonly prefix = 'dedupe:') {}
  async checkAndSet(key: string): Promise<boolean> {
    const res = await this.redis.set(this.prefix + key, '1', 'NX', 'EX', this.ttlSeconds);
    return res !== null; // 'OK' = new, null = duplicate
  }
}
