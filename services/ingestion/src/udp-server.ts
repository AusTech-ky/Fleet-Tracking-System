import dgram from 'node:dgram';
import { decodeUdpDatagram, buildUdpAck } from '@fleet/protocol-teltonika';
import { normalize } from './avl-map.ts';
import { dedupeKey, type Deduper } from './dedupe.ts';
import type { Sink } from './sinks.ts';
import type { Metrics } from './metrics.ts';
import type { Logger } from './logger.ts';

export interface UdpDeps {
  isAllowed: (imei: string) => boolean | Promise<boolean>;
  sink: Sink;
  deduper: Deduper;
  metrics: Metrics;
  logger: Logger;
}

/**
 * Teltonika Codec 8/8E over UDP. Connectionless: each datagram is self-contained
 * (IMEI is inside the datagram, no CRC, UDP provides framing). We durably write
 * then ack by echoing the packet id + accepted count. A device retransmits if it
 * does not get a valid ack within its timeout, so ack-after-write still holds.
 */
export class IngestionUdpServer {
  private socket: dgram.Socket;
  constructor(
    private readonly configuredPort: number,
    private readonly deps: UdpDeps,
  ) {
    this.socket = dgram.createSocket({ type: 'udp6', ipv6Only: false });
    this.socket.on('message', (msg, rinfo) => void this.onMessage(msg, rinfo));
    this.socket.on('error', (err) => this.deps.logger.error('udp socket error', { err: err.message }));
  }

  private async onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    try {
      const d = decodeUdpDatagram(msg);
      if (!(await this.deps.isAllowed(d.imei))) {
        this.deps.metrics.rejectedImeis.inc();
        return; // silently drop unprovisioned devices over UDP
      }
      this.deps.metrics.packetsTotal.inc({ transport: 'udp' });
      const fresh = [];
      for (const rec of d.avl.records) {
        if (await this.deps.deduper.checkAndSet(dedupeKey(d.imei, rec))) fresh.push(normalize(d.imei, rec));
        else this.deps.metrics.duplicatesDropped.inc();
      }
      await this.deps.sink.write(fresh); // durable BEFORE ack
      const ack = buildUdpAck(d.packetId, d.avlPacketId, d.avl.recordCount);
      this.socket.send(ack, rinfo.port, rinfo.address);
      this.deps.metrics.recordsTotal.inc({ imei: d.imei }, fresh.length);
    } catch (err) {
      // No ack on error -> device retransmits.
      this.deps.metrics.decodeErrors.inc({ reason: 'udp' });
      this.deps.logger.warn('udp decode error (no ack, device will resend)', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.bind(this.configuredPort, () => {
        this.deps.logger.info('udp ingestion listening', { port: this.port });
        resolve();
      });
    });
  }

  get port(): number {
    return this.socket.address().port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.socket.close(() => resolve()));
  }
}
