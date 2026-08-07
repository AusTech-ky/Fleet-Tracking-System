import {
  parseImei,
  ACCEPT,
  REJECT,
  extractFrame,
  decodeTcpPacket,
  buildTcpAck,
  decodeCodec12,
  encodeCommand,
  TYPE_RESPONSE,
  TeltonikaDecodeError,
  CODEC_8,
  CODEC_8_EXT,
  CODEC_16,
  CODEC_12,
} from '@fleet/protocol-teltonika';
import { normalize } from './avl-map.ts';
import { dedupeKey, type Deduper } from './dedupe.ts';
import type { Sink } from './sinks.ts';
import type { Metrics } from './metrics.ts';
import type { Logger } from './logger.ts';

export interface SessionTransport {
  send(buf: Buffer): void;
  close(): void;
}

export interface SessionDeps {
  isAllowed: (imei: string) => boolean | Promise<boolean>;
  sink: Sink;
  deduper: Deduper;
  metrics: Metrics;
  logger: Logger;
  now?: () => number;
  /** called once the IMEI is accepted, so the server can register for downlink */
  onAuthenticated?: (imei: string, session: Session) => void;
  onClose?: (session: Session) => void;
}

/**
 * Per-connection TCP session for one Teltonika device. Handles the IMEI login,
 * then routes each framed packet by codec id: AVL (0x08/0x8E) -> decode, dedupe,
 * durable-write, THEN ack; Codec 12 (0x0C) -> a downlink command response.
 *
 * Processing is serialized (a single in-flight chain) so ack ordering and the
 * durable-write-before-ack invariant always hold even under coalesced TCP reads.
 */
export class Session {
  imei: string | null = null;
  private buffer = Buffer.alloc(0);
  private chain: Promise<void> = Promise.resolve();
  private pendingCommands: { resolve: (text: string) => void; reject: (e: Error) => void }[] = [];
  private readonly now: () => number;

  constructor(private readonly transport: SessionTransport, private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Feed bytes from the socket. Safe to call repeatedly; work is serialized. */
  onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.chain = this.chain.then(() => this.drain()).catch((err) => this.fail(err));
  }

  /** Send a Codec 12 GPRS command; resolves with the device's response text. */
  sendCommand(command: string, timeoutMs = 30_000): Promise<string> {
    if (!this.imei) throw new Error('Cannot send command before IMEI login');
    this.transport.send(encodeCommand(command));
    this.deps.metrics.downlinkSent.inc({ imei: this.imei });
    return new Promise<string>((resolve, reject) => {
      const entry = { resolve, reject };
      this.pendingCommands.push(entry);
      const timer = setTimeout(() => {
        const i = this.pendingCommands.indexOf(entry);
        if (i >= 0) this.pendingCommands.splice(i, 1);
        reject(new Error(`Codec12 command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const wrap = (fn: (v: string) => void) => (v: string) => { clearTimeout(timer); fn(v); };
      entry.resolve = wrap(resolve);
      entry.reject = wrap(reject as (v: string) => void) as unknown as (e: Error) => void;
    });
  }

  private async drain(): Promise<void> {
    // Phase 1: IMEI login.
    if (this.imei === null) {
      const login = parseImei(this.buffer);
      if (!login) return;
      this.buffer = this.buffer.subarray(login.bytesConsumed);
      const allowed = await this.deps.isAllowed(login.imei);
      if (!allowed) {
        this.deps.metrics.rejectedImeis.inc();
        this.deps.logger.warn('imei rejected', { imei: login.imei });
        this.transport.send(REJECT);
        this.transport.close();
        return;
      }
      this.imei = login.imei;
      this.transport.send(ACCEPT);
      this.deps.logger.info('imei accepted', { imei: this.imei });
      this.deps.onAuthenticated?.(this.imei, this);
    }

    // Phase 2: framed packets (AVL or Codec 12 response), possibly several.
    let f = extractFrame(this.buffer);
    while (f) {
      this.buffer = f.rest;
      const codecId = f.frame[8];
      if (codecId === CODEC_12) {
        this.handleCodec12(f.frame);
      } else if (codecId === CODEC_8 || codecId === CODEC_8_EXT || codecId === CODEC_16) {
        await this.handleAvl(f.frame);
      } else {
        throw new TeltonikaDecodeError(`Unknown codec 0x${codecId.toString(16)}`);
      }
      f = extractFrame(this.buffer);
    }
  }

  private async handleAvl(frame: Buffer): Promise<void> {
    const started = this.now();
    const pkt = decodeTcpPacket(frame); // throws on CRC/format -> fail() (no ack)
    this.deps.metrics.packetsTotal.inc({ transport: 'tcp' });

    const fresh = [];
    for (const rec of pkt.records) {
      const isNew = await this.deps.deduper.checkAndSet(dedupeKey(this.imei!, rec));
      if (isNew) fresh.push(normalize(this.imei!, rec));
      else this.deps.metrics.duplicatesDropped.inc();
    }

    // Durable write BEFORE ack. If this throws, fail() runs and we never ack,
    // so the device keeps the records and resends on reconnect.
    await this.deps.sink.write(fresh);

    this.transport.send(buildTcpAck(pkt.recordCount)); // ack ALL received (incl. dupes)
    this.deps.metrics.recordsTotal.inc({ imei: this.imei! }, fresh.length);
    this.deps.metrics.ackLatency.observe((this.now() - started) / 1000);
    this.deps.logger.debug('avl acked', { imei: this.imei, received: pkt.recordCount, stored: fresh.length });
  }

  private handleCodec12(frame: Buffer): void {
    const msg = decodeCodec12(frame);
    if (msg.type !== TYPE_RESPONSE) {
      this.deps.logger.warn('unexpected codec12 message type from device', { type: msg.type });
      return;
    }
    const pending = this.pendingCommands.shift();
    if (pending) pending.resolve(msg.payload);
    else this.deps.logger.warn('codec12 response with no pending command', { imei: this.imei });
  }

  private fail(err: unknown): void {
    const reason = err instanceof TeltonikaDecodeError ? 'decode' : 'handler';
    this.deps.metrics.decodeErrors.inc({ reason });
    this.deps.logger.warn('session error, dropping without ack (device will resend)', {
      imei: this.imei,
      reason,
      err: err instanceof Error ? err.message : String(err),
    });
    this.transport.close();
  }

  handleClosed(): void {
    for (const p of this.pendingCommands.splice(0)) p.reject(new Error('connection closed'));
    this.deps.onClose?.(this);
  }
}
