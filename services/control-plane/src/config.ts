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
}

export function loadConfig(env = process.env): Config {
  const useInMemory = env.USE_IN_MEMORY === 'true' || (!env.DATABASE_URL && !env.REDIS_URL);
  const jwtSecret = env.JWT_SECRET ?? (useInMemory ? 'dev-insecure-secret-change-me' : '');
  if (!jwtSecret) throw new Error('JWT_SECRET is required in production');
  return {
    port: Number(env.PORT ?? 3000),
    jwtSecret,
    // Access tokens are the ONLY credential today — there is no refresh-token
    // flow yet, so a 15m lifetime meant the UI died mid-session with an
    // "Invalid token" error. 12h keeps a working day usable. Shorten this once
    // refresh tokens land (see ARCHITECTURE §8).
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '12h',
    useInMemory,
    databaseUrl: env.DATABASE_URL ?? null,
    redisUrl: env.REDIS_URL ?? null,
    throttleLimit: Number(env.THROTTLE_LIMIT ?? 300),
    throttleTtlMs: Number(env.THROTTLE_TTL_MS ?? 60_000),
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
