import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeImei, encodeResponse, extractCodec12Frame, decodeCodec12 } from '@fleet/protocol-teltonika';
import { App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Sink } from '../src/sinks.ts';
import type { NormalizedTelemetry } from '../src/avl-map.ts';

const IMEI = '356307042441013';
const CODEC8 =
  '000000000000003608010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E0000000000000000010000C7CF';
// UDP vendor datagram — IMEI 352093086403655.
const UDP_SAMPLE =
  '003DCAFE0105000F33353230393330383634303336353508010000016B4F815B30010000000000000000000000000000000103021503010101425DBC000001';
const UDP_IMEI = '352093086403655';

class Capture implements Sink {
  records: NormalizedTelemetry[] = [];
  async write(recs: NormalizedTelemetry[]) { this.records.push(...recs); }
  async close() {}
}

/** Minimal promise-based device TCP client. */
class Device {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private waiter: { n: number; resolve: (b: Buffer) => void } | null = null;
  connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(port, '127.0.0.1', resolve);
      this.sock.on('error', reject);
      this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    });
  }
  private pump() {
    if (this.waiter && this.buf.length >= this.waiter.n) {
      const { n, resolve } = this.waiter;
      this.waiter = null;
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      resolve(out);
    }
  }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve) => { this.waiter = { n, resolve }; this.pump(); });
  }
  /** Read a full preamble-framed packet (for Codec 12 command from server). */
  async readFramed(): Promise<Buffer> {
    const head = await this.read(8);
    const size = head.readUInt32BE(4);
    const rest = await this.read(size + 4);
    return Buffer.concat([head, rest]);
  }
  write(b: Buffer) { this.sock.write(b); }
  end() { this.sock.end(); }
}

async function startApp(overrides: Partial<Record<string, string>> = {}) {
  const walDir = mkdtempSync(join(tmpdir(), 'ingest-e2e-'));
  const config = loadConfig({
    TCP_PORT: '0', UDP_PORT: '0', HTTP_PORT: '0', SHUTDOWN_GRACE_MS: '300',
    WAL_DIR: walDir, ALLOWED_IMEIS: `${IMEI},${UDP_IMEI}`, ...overrides,
  } as NodeJS.ProcessEnv);
  const capture = new Capture();
  const app = new App(config, { sink: capture, logger: silentLogger() });
  await app.start();
  return { app, capture, walDir };
}

function silentLogger() {
  const noop = () => {};
  const l: any = { debug: noop, info: noop, warn: noop, error: noop };
  l.child = () => l;
  return l;
}

test('TCP: handshake, decode, durable-write, ack; record captured', async () => {
  const { app, capture, walDir } = await startApp();
  try {
    const dev = new Device();
    await dev.connect(app.tcp.port);
    dev.write(encodeImei(IMEI));
    assert.equal((await dev.read(1))[0], 0x01, 'accept');
    dev.write(Buffer.from(CODEC8, 'hex'));
    assert.deepEqual(await dev.read(4), Buffer.from([0, 0, 0, 1]), 'ack of 1 record');
    assert.equal(capture.records.length, 1);
    assert.equal(capture.records[0].imei, IMEI);
    assert.equal(capture.records[0].fields.gsmSignal, 3);
    dev.end();
  } finally {
    await app.stop();
    rmSync(walDir, { recursive: true, force: true });
  }
});

test('TCP: duplicate packet is acked but stored only once', async () => {
  const { app, capture, walDir } = await startApp();
  try {
    const dev = new Device();
    await dev.connect(app.tcp.port);
    dev.write(encodeImei(IMEI));
    await dev.read(1);
    dev.write(Buffer.from(CODEC8, 'hex'));
    assert.deepEqual(await dev.read(4), Buffer.from([0, 0, 0, 1]));
    dev.write(Buffer.from(CODEC8, 'hex')); // exact resend
    assert.deepEqual(await dev.read(4), Buffer.from([0, 0, 0, 1]), 'still acked');
    assert.equal(capture.records.length, 1, 'deduped: stored once');
    dev.end();
  } finally {
    await app.stop();
    rmSync(walDir, { recursive: true, force: true });
  }
});

test('TCP: unprovisioned IMEI rejected with 0x00', async () => {
  const { app, walDir } = await startApp({ ALLOWED_IMEIS: IMEI });
  try {
    const dev = new Device();
    await dev.connect(app.tcp.port);
    dev.write(encodeImei('999999999999999'));
    assert.equal((await dev.read(1))[0], 0x00);
  } finally {
    await app.stop();
    rmSync(walDir, { recursive: true, force: true });
  }
});

test('Downlink: Codec 12 command round-trips to a response', async () => {
  const { app, walDir } = await startApp();
  try {
    const dev = new Device();
    await dev.connect(app.tcp.port);
    dev.write(encodeImei(IMEI));
    await dev.read(1);
    // device must have sent data + been acked at least once? Not required by our
    // server, but the session must be authenticated (it is). Send a command:
    const respPromise = app.tcp.sendCommand(IMEI, 'getinfo');
    const cmdFrame = await dev.readFramed();
    assert.equal(decodeCodec12(cmdFrame).payload, 'getinfo');
    dev.write(encodeResponse('INI:2026/7/24 GPS:3 GSM:5'));
    assert.equal(await respPromise, 'INI:2026/7/24 GPS:3 GSM:5');
    dev.end();
  } finally {
    await app.stop();
    rmSync(walDir, { recursive: true, force: true });
  }
});

test('UDP: datagram decoded, durable-write, ack echoes packet id', async () => {
  const { app, capture, walDir } = await startApp();
  try {
    const client = dgram.createSocket('udp4');
    const ackPromise = new Promise<Buffer>((resolve) => client.on('message', resolve));
    await new Promise<void>((r) => client.bind(r));
    client.send(Buffer.from(UDP_SAMPLE, 'hex'), app.udp!.port, '127.0.0.1');
    const ack = await ackPromise;
    assert.equal(ack.toString('hex'), '0005cafe010501');
    assert.equal(capture.records.length, 1);
    assert.equal(capture.records[0].imei, UDP_IMEI);
    client.close();
  } finally {
    await app.stop();
    rmSync(walDir, { recursive: true, force: true });
  }
});

test('Metrics endpoint reports records after ingest', async () => {
  const { app, walDir } = await startApp();
  try {
    const dev = new Device();
    await dev.connect(app.tcp.port);
    dev.write(encodeImei(IMEI));
    await dev.read(1);
    dev.write(Buffer.from(CODEC8, 'hex'));
    await dev.read(4);
    dev.end();

    const port = (app.health.address as net.AddressInfo).port;
    const body = await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text());
    assert.match(body, /ingest_records_total/);
    assert.match(body, /ingest_packets_total\{transport="tcp"\} 1/);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(ready.status, 200);
  } finally {
    await app.stop();
    rmSync(walDir, { recursive: true, force: true });
  }
});

test('Graceful shutdown drains active connections', async () => {
  const { app, walDir } = await startApp();
  const dev = new Device();
  await dev.connect(app.tcp.port);
  dev.write(encodeImei(IMEI));
  await dev.read(1);
  const closed = new Promise<void>((resolve) => (dev as any).sock.on('close', resolve));
  await app.stop(); // should close the socket
  await closed; // resolves => connection was drained
  rmSync(walDir, { recursive: true, force: true });
});
