import net from 'node:net';
import { parseImei, ACCEPT, REJECT } from '../codec/imei.ts';
import {
  decodeTcpPacket,
  extractFrame,
  buildAck,
  TeltonikaDecodeError,
  type AvlRecord,
} from '../codec/teltonika-codec.ts';
import { mapIo } from '../avl-ids.ts';

/**
 * Prototype Teltonika TCP ingestion server for the FTC927.
 *
 * Demonstrates the full protocol contract end-to-end:
 *   1. IMEI login  -> allow-list check -> 0x01 accept / 0x00 reject
 *   2. Codec 8/8E frames -> CRC verify -> decode -> map AVL IDs
 *   3. "persist" (here: a pluggable sink) THEN 4-byte ack (ack-after-write)
 *
 * Production notes (see ARCHITECTURE.md):
 *   - The sink here is in-memory. In production, ack ONLY after the records are
 *     durably enqueued (Kafka/Redis Stream/WAL) — the device deletes acked
 *     records from flash, so a premature ack is permanent data loss.
 *   - Dedupe on (imei, timestamp, hash) because Duplicate secondary-server mode
 *     can deliver the same record twice.
 *   - TLS: wrap with tls.createServer once device certs are provisioned.
 */

export type Sink = (msg: {
  imei: string;
  record: AvlRecord;
  telemetry: ReturnType<typeof mapIo>;
}) => Promise<void> | void;

export interface ServerOptions {
  port: number;
  host?: string;
  /** returns true if this IMEI is provisioned and allowed to send */
  isAllowed: (imei: string) => boolean | Promise<boolean>;
  sink: Sink;
  /** drop idle sockets after this many ms with no data (keep-alive tolerance) */
  idleTimeoutMs?: number;
  log?: (...args: unknown[]) => void;
}

export function createIngestionServer(opts: ServerOptions): net.Server {
  const log = opts.log ?? (() => {});

  const server = net.createServer((socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    let imei: string | null = null;
    let buffer = Buffer.alloc(0);
    socket.setTimeout(opts.idleTimeoutMs ?? 120_000);

    socket.on('timeout', () => {
      log(`[${peer}] idle timeout, closing`);
      socket.destroy();
    });

    socket.on('data', async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      try {
        // Phase 1: IMEI login (once per connection).
        if (imei === null) {
          const login = parseImei(buffer);
          if (!login) return; // wait for more bytes
          buffer = buffer.subarray(login.bytesConsumed);
          const allowed = await opts.isAllowed(login.imei);
          if (!allowed) {
            log(`[${peer}] rejected IMEI ${login.imei}`);
            socket.end(REJECT);
            return;
          }
          imei = login.imei;
          socket.write(ACCEPT);
          log(`[${peer}] accepted IMEI ${imei}`);
        }

        // Phase 2: AVL data frames (may be fragmented or coalesced).
        let frameInfo = extractFrame(buffer);
        while (frameInfo) {
          buffer = frameInfo.rest;
          const pkt = decodeTcpPacket(frameInfo.frame);

          // ack-after-write: persist every record before acknowledging.
          for (const record of pkt.records) {
            await opts.sink({ imei, record, telemetry: mapIo(record.io.values) });
          }
          socket.write(buildAck(pkt.recordCount));
          log(`[${peer}] ${imei} +${pkt.recordCount} records (codec 0x${pkt.codecId.toString(16)}), acked`);

          frameInfo = extractFrame(buffer);
        }
      } catch (err) {
        if (err instanceof TeltonikaDecodeError) {
          // A framing/CRC error means the stream is unreliable: drop the socket
          // WITHOUT acking so the device resends from its flash on reconnect.
          log(`[${peer}] decode error: ${err.message} — dropping (no ack, device will resend)`);
          socket.destroy();
        } else {
          log(`[${peer}] handler error:`, err);
          socket.destroy();
        }
      }
    });

    socket.on('error', (err) => log(`[${peer}] socket error: ${err.message}`));
    socket.on('close', () => log(`[${peer}] closed (imei=${imei ?? 'unknown'})`));
  });

  server.listen(opts.port, opts.host ?? '::', () =>
    log(`Teltonika ingestion listening on ${opts.host ?? '::'}:${opts.port}`),
  );
  return server;
}

// Run standalone: `node src/server/tcp-server.ts`
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const allow = new Set((process.env.ALLOWED_IMEIS ?? '').split(',').filter(Boolean));
  createIngestionServer({
    port: Number(process.env.PORT ?? 5027),
    isAllowed: (imei) => allow.size === 0 || allow.has(imei),
    sink: ({ imei, record, telemetry }) => {
      const { latitude, longitude, speed } = record.gps;
      console.log(
        `RECORD imei=${imei} t=${record.timestamp.toISOString()} ` +
          `lat=${latitude} lon=${longitude} speed=${speed} ` +
          `ign=${telemetry.ignition ?? '-'} ext=${telemetry.externalVoltage ?? '-'}mV`,
      );
    },
    log: (...a) => console.log(...a),
  });
}
