/** Environment configuration for the control-plane service. */
export interface Config {
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string;
  /** true = in-memory repos/integrations (tests, local dev without infra) */
  useInMemory: boolean;
  databaseUrl: string | null;
  redisUrl: string | null;
  /** rate limiting: max requests per IP per window */
  throttleLimit: number;
  throttleTtlMs: number;
  /** allowed CORS origins; empty = reflect any origin */
  corsOrigins: string[];
  /**
   * Ingestion service's internal command endpoint (POST /commands) and the
   * shared secret it expects. null URL = remote device configuration disabled.
   * In the all-in-one container both services share localhost, so the default
   * points at ingestion's admin port there.
   */
  ingestCommandUrl: string | null;
  ingestCommandSecret: string;
}

export function loadConfig(env = process.env): Config {
  const useInMemory = env.USE_IN_MEMORY === 'true' || (!env.DATABASE_URL && !env.REDIS_URL);
  const jwtSecret = env.JWT_SECRET ?? (useInMemory ? 'dev-insecure-secret-change-me' : '');
  if (!jwtSecret) throw new Error('JWT_SECRET is required in production');
  return {
    port: Number(env.PORT ?? 3000),
    jwtSecret,
    // Short-lived by design: the frontend silently exchanges the rotating
    // refresh token for a new one, so users never see a session drop.
    // Refresh lifetime: REFRESH_EXPIRES_DAYS (default 30).

    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '15m',
    useInMemory,
    databaseUrl: env.DATABASE_URL ?? null,
    redisUrl: env.REDIS_URL ?? null,
    throttleLimit: Number(env.THROTTLE_LIMIT ?? 300),
    throttleTtlMs: Number(env.THROTTLE_TTL_MS ?? 60_000),
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    ingestCommandUrl: env.INGEST_COMMAND_URL ?? (useInMemory ? null : 'http://127.0.0.1:9100/commands'),
    ingestCommandSecret: env.INGEST_COMMAND_SECRET ?? '',
  };
}
