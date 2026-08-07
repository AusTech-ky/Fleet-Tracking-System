import type { Config } from './config.ts';
import { createLogger, type Logger } from './logger.ts';
import { Metrics } from './metrics.ts';
import { InMemoryDeduper, RedisDeduper, type Deduper, type RedisLike } from './dedupe.ts';
import { WalSink, StreamBusSink, CompositeSink, type Sink, type StreamProducer } from './sinks.ts';
import { IngestionTcpServer } from './tcp-server.ts';
import { IngestionUdpServer } from './udp-server.ts';
import { HealthServer } from './health.ts';
import { StaticAllowList, type AllowList } from './allowlist.ts';

/**
 * Composition root. Wires config -> dependencies -> servers, and owns the
 * lifecycle (start / graceful shutdown). External infra (Redis, stream bus) is
 * injected so the whole app is testable in-process with fakes.
 */
export interface AppOverrides {
  logger?: Logger;
  sink?: Sink;
  deduper?: Deduper;
  redis?: RedisLike;
  streamProducer?: StreamProducer;
  /** device auth source; defaults to the static config allow-list */
  allowList?: AllowList;
}

export class App {
  readonly metrics = new Metrics();
  readonly logger: Logger;
  readonly sink: Sink;
  readonly deduper: Deduper;
  readonly tcp: IngestionTcpServer;
  readonly udp: IngestionUdpServer | null;
  readonly health: HealthServer;
  private started = false;

  constructor(private readonly config: Config, overrides: AppOverrides = {}) {
    this.logger = overrides.logger ?? createLogger();

    // Sink: WAL always (DR fallback) + stream bus when a producer is available.
    const sinks: Sink[] = [overrides.sink ?? new WalSink(config.walDir)];
    if (overrides.streamProducer) sinks.push(new StreamBusSink(overrides.streamProducer));
    this.sink = sinks.length === 1 ? sinks[0] : new CompositeSink(sinks);

    // Deduper: Redis when configured (shared across nodes), else in-memory.
    this.deduper =
      overrides.deduper ??
      (overrides.redis
        ? new RedisDeduper(overrides.redis, config.dedupeTtlSeconds)
        : new InMemoryDeduper(config.dedupeTtlSeconds * 1000));

    // Device auth: shared Redis allow-list (control-plane-published) when provided,
    // else the static config list. This is the loop-closure with provisioning.
    const allowList: AllowList = overrides.allowList ?? new StaticAllowList(config.allowedImeis);

    const deps = {
      isAllowed: (imei: string) => allowList.isAllowed(imei),
      sink: this.sink,
      deduper: this.deduper,
      metrics: this.metrics,
      logger: this.logger,
    };

    this.tcp = new IngestionTcpServer(config, deps, this.metrics, this.logger);
    this.udp = config.udpPort != null ? new IngestionUdpServer(config.udpPort, deps) : null;
    this.health = new HealthServer(config.httpPort, this.metrics, () => this.started);
  }

  async start(): Promise<void> {
    await Promise.all([this.tcp.listen(), this.udp?.listen(), this.health.listen()]);
    this.started = true;
    this.logger.info('ingestion service started', {
      tcpPort: this.config.tcpPort,
      udpPort: this.config.udpPort,
      httpPort: this.config.httpPort,
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.logger.info('shutting down');
    await this.tcp.drain(this.config.shutdownGraceMs); // stop accepting, drain sockets (unacked records resend)
    await this.udp?.close();
    await this.sink.close(); // flush WAL / bus
    await this.health.close();
    this.logger.info('shutdown complete');
  }
}
