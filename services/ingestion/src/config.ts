/**
 * Validated environment configuration. Fail-fast: any invalid value throws at
 * boot rather than surfacing as a confusing runtime error later.
 */
export interface Config {
  tcpPort: number;
  udpPort: number | null; // null = UDP disabled
  httpPort: number; // health + metrics
  tls: { enabled: boolean; keyPath?: string; certPath?: string; caPath?: string };
  walDir: string;
  idleTimeoutMs: number;
  maxConnections: number;
  /** comma-separated IMEI allow-list; empty = allow all (dev only) */
  allowedImeis: Set<string>;
  redisUrl: string | null;
  dedupeTtlSeconds: number;
  activeDataLinkTimeoutSec: number; // recommend 259200 on device for downlink
  shutdownGraceMs: number; // how long to let sockets drain before force-close
  /**
   * Shared secret the control-plane presents to POST /commands (downlink to a
   * device). Empty disables the endpoint entirely — never leave it open.
   */
  commandSecret: string;
}

function int(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const raw = env[name];
  if (raw == null || raw === '') return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return v;
}

export function loadConfig(env = process.env): Config {
  const tlsEnabled = env.TLS_ENABLED === 'true';
  if (tlsEnabled && (!env.TLS_KEY_PATH || !env.TLS_CERT_PATH)) {
    throw new Error('TLS_ENABLED=true requires TLS_KEY_PATH and TLS_CERT_PATH');
  }
  return {
    tcpPort: int(env, 'TCP_PORT', 5027),
    udpPort: env.UDP_PORT === 'off' ? null : int(env, 'UDP_PORT', 5027),
    httpPort: int(env, 'HTTP_PORT', 9100),
    tls: {
      enabled: tlsEnabled,
      keyPath: env.TLS_KEY_PATH,
      certPath: env.TLS_CERT_PATH,
      caPath: env.TLS_CA_PATH,
    },
    walDir: env.WAL_DIR ?? './.wal',
    idleTimeoutMs: int(env, 'IDLE_TIMEOUT_MS', 300_000),
    maxConnections: int(env, 'MAX_CONNECTIONS', 50_000),
    allowedImeis: new Set((env.ALLOWED_IMEIS ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    redisUrl: env.REDIS_URL ?? null,
    dedupeTtlSeconds: int(env, 'DEDUPE_TTL_SECONDS', 86_400),
    activeDataLinkTimeoutSec: int(env, 'ACTIVE_DATALINK_TIMEOUT_SEC', 259_200),
    shutdownGraceMs: int(env, 'SHUTDOWN_GRACE_MS', 15_000),
    commandSecret: env.INGEST_COMMAND_SECRET ?? '',
  };
}
