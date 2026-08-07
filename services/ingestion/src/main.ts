import { loadConfig } from './config.ts';
import { App, type AppOverrides } from './app.ts';
import { RedisAllowList } from './allowlist.ts';

/**
 * Entry point. Boots the ingestion service and wires SIGTERM/SIGINT to a
 * graceful drain (Kubernetes sends SIGTERM before removing the pod; devices
 * reconnect to another node and resend any unacked records).
 */
const config = loadConfig();

const overrides: AppOverrides = {};
if (config.redisUrl) {
  // Shared allow-list published by the control-plane. ioredis is an optional
  // dependency; only required when REDIS_URL is set.
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(config.redisUrl);
  overrides.allowList = new RedisAllowList(redis);
  // Also use Redis for cross-node dedupe and as the stream-bus producer.
  overrides.redis = redis as unknown as AppOverrides['redis'];
  overrides.streamProducer = {
    append: async (stream, entries) => {
      const pipe = redis.pipeline();
      for (const e of entries) pipe.xadd(stream, '*', ...Object.entries(e).flat());
      await pipe.exec();
    },
  };
}

const app = new App(config, overrides);

async function shutdown(signal: string) {
  app.logger.info('signal received', { signal });
  try {
    await app.stop();
    process.exit(0);
  } catch (err) {
    app.logger.error('error during shutdown', { err: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => app.logger.error('uncaughtException', { err: err.message }));
process.on('unhandledRejection', (err) => app.logger.error('unhandledRejection', { err: String(err) }));

app.start().catch((err) => {
  app.logger.error('failed to start', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
