import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createIngestionServer, type Sink } from '../src/server/tcp-server.ts';

const CODEC8_SAMPLE =
  '000000000000003608010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E0000000000000000010000C7CF';
const IMEI = '356307042441013';

function imeiFrame(imei: string): Buffer {
  return Buffer.concat([Buffer.from([0x00, 0x0f]), Buffer.from(imei, 'ascii')]);
}

/** Run one full device session against a live server; resolve with received bytes. */
function runSession(port: number, frames: Buffer[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('error', reject);
    sock.on('close', () => resolve(Buffer.concat(chunks)));
    sock.on('connect', () => {
      for (const f of frames) sock.write(f);
      // give the server a tick to respond, then close
      setTimeout(() => sock.end(), 150);
    });
  });
}

test('end-to-end: accepted IMEI, decoded record, correct 4-byte ack', async () => {
  const received: string[] = [];
  const sink: Sink = ({ imei, telemetry }) => {
    received.push(`${imei}:${telemetry.gsmSignal ?? '-'}`);
  };
  const server = createIngestionServer({
    port: 0, // ephemeral
    isAllowed: (imei) => imei === IMEI,
    sink,
  });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;

  const reply = await runSession(port, [
    imeiFrame(IMEI),
    Buffer.from(CODEC8_SAMPLE, 'hex'),
  ]);

  // Byte 0 = 0x01 accept; bytes 1..4 = ack count = 1.
  assert.equal(reply[0], 0x01, 'server should accept the IMEI');
  assert.deepEqual(
    reply.subarray(1, 5),
    Buffer.from([0x00, 0x00, 0x00, 0x01]),
    'server should ack exactly 1 record',
  );
  // The record was persisted (sink ran) before the ack was sent.
  assert.deepEqual(received, [`${IMEI}:3`]);

  server.close();
});

test('end-to-end: unprovisioned IMEI is rejected with 0x00', async () => {
  const server = createIngestionServer({
    port: 0,
    isAllowed: () => false,
    sink: () => {},
  });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;

  const reply = await runSession(port, [imeiFrame('999999999999999')]);
  assert.equal(reply[0], 0x00, 'server should reject with 0x00');
  assert.equal(reply.length, 1, 'no data should be acked');

  server.close();
});
