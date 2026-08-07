/**
 * Ingestion-side view of the IMEI allow-list that the control-plane publishes to
 * a shared Redis SET (key `ingest:allowed_imeis`). This is what closes the loop:
 * provisioning a device in the control-plane makes ingestion accept it with no
 * redeploy. Membership is cached briefly to keep the auth check off the hot path.
 */
export interface AllowList {
  isAllowed(imei: string): Promise<boolean>;
}

/** Static allow-list from config (dev, or single-node without Redis). */
export class StaticAllowList implements AllowList {
  constructor(private readonly set: Set<string>) {}
  async isAllowed(imei: string) {
    return this.set.size === 0 || this.set.has(imei);
  }
}

/** Minimal Redis surface needed here (satisfied by ioredis). */
export interface RedisSetClient {
  sismember(key: string, member: string): Promise<number>;
}

/**
 * Redis-backed allow-list with a short positive/negative TTL cache so a connected
 * device's every packet doesn't hit Redis. A newly provisioned device is accepted
 * within `cacheTtlMs`; a revoked one is rejected within the same window.
 */
export class RedisAllowList implements AllowList {
  private cache = new Map<string, { allowed: boolean; exp: number }>();
  constructor(
    private readonly redis: RedisSetClient,
    private readonly key = 'ingest:allowed_imeis',
    private readonly cacheTtlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}
  async isAllowed(imei: string): Promise<boolean> {
    const t = this.now();
    const hit = this.cache.get(imei);
    if (hit && hit.exp > t) return hit.allowed;
    const allowed = (await this.redis.sismember(this.key, imei)) === 1;
    this.cache.set(imei, { allowed, exp: t + this.cacheTtlMs });
    return allowed;
  }
}
