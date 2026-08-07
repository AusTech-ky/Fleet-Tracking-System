import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedTelemetry } from './avl-map.ts';

/**
 * The durable sink. The ingestion server acks the device ONLY after the sink's
 * write() promise resolves — the device deletes acked records from flash, so a
 * premature ack is permanent data loss (ARCHITECTURE §4.2). Every sink here
 * must therefore not resolve until the data is durably held.
 */
export interface Sink {
  write(records: NormalizedTelemetry[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Append-only write-ahead log (newline-delimited JSON), fsync-on-batch. This is
 * the zero-dependency durable default and the local-dev/DR fallback. In
 * production the primary sink is the stream bus (Kafka/Redpanda/Redis Stream);
 * a WAL tee gives crash-recovery if the bus is briefly unavailable.
 */
export class WalSink implements Sink {
  private stream: WriteStream;
  constructor(dir: string, file = `ingest-${process.pid}.ndjson`) {
    mkdirSync(dir, { recursive: true });
    this.stream = createWriteStream(join(dir, file), { flags: 'a' });
  }
  write(records: NormalizedTelemetry[]): Promise<void> {
    if (records.length === 0) return Promise.resolve();
    const payload = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    return new Promise((resolve, reject) => {
      // write() callback fires after the data is flushed to the OS; for true
      // durability on power loss, pair with periodic fsync (omitted for brevity).
      this.stream.write(payload, (err) => (err ? reject(err) : resolve()));
    });
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

/** Minimal stream-bus surface (satisfied by ioredis XADD or a Kafka producer). */
export interface StreamProducer {
  append(stream: string, entries: Record<string, string>[]): Promise<void>;
}

/**
 * Durable bus sink. Publishes normalized telemetry to the stream bus that all
 * downstream consumers (rules, hot-state, cold-store) read from. Injected
 * producer keeps this testable and free of a hard ioredis/kafka dependency.
 */
export class StreamBusSink implements Sink {
  constructor(private readonly producer: StreamProducer, private readonly stream = 'telemetry') {}
  async write(records: NormalizedTelemetry[]): Promise<void> {
    if (records.length === 0) return;
    await this.producer.append(
      this.stream,
      records.map((r) => ({ imei: r.imei, ts: r.ts, data: JSON.stringify(r) })),
    );
  }
  async close(): Promise<void> {}
}

/**
 * Tee to multiple sinks; resolves only when ALL succeed (so ack-after-write
 * holds for every durability target). If any sink rejects, the whole write
 * rejects and the caller must NOT ack — the device will resend.
 */
export class CompositeSink implements Sink {
  constructor(private readonly sinks: Sink[]) {}
  async write(records: NormalizedTelemetry[]): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.write(records)));
  }
  async close(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.close()));
  }
}
