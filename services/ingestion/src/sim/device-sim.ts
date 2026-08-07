import net from 'node:net';
import { encodeImei, encodeTcpPacket, CODEC_8 } from '@fleet/protocol-teltonika';

/**
 * FTC927 device simulator for load/soak testing the ingestion service.
 * Spawns N virtual devices, each connecting over TCP, logging in with a unique
 * IMEI, and sending a periodic AVL record; verifies it receives the 4-byte ack.
 *
 * Usage:
 *   node --experimental-transform-types src/sim/device-sim.ts \
 *     --host=127.0.0.1 --port=5027 --devices=1000 --interval=10000
 *
 * (For a real load test, point --devices into the tens of thousands across
 *  several sim processes and watch /metrics on the service — see ARCHITECTURE §19.)
 */
function arg(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
}

const HOST = arg('host', '127.0.0.1');
const PORT = Number(arg('port', '5027'));
const DEVICES = Number(arg('devices', '100'));
const INTERVAL = Number(arg('interval', '10000'));

/** Build a single-record Codec 8 AVL packet with a live timestamp and a few IOs. */
function buildPacket(ms: number, ignition: number, speed: number): Buffer {
  const rec = Buffer.alloc(0);
  const parts: Buffer[] = [];
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(ms));
  parts.push(ts, Buffer.from([0x01])); // priority high
  const gps = Buffer.alloc(15);
  gps.writeInt32BE(Math.round(-81.3 * 1e7), 0); // lon (Cayman)
  gps.writeInt32BE(Math.round(19.3 * 1e7), 4); // lat
  gps.writeUInt16BE(speed, 13);
  parts.push(gps);
  // IO: event 0, one 1-byte (ignition=239), one 2-byte (ext voltage=66)
  parts.push(Buffer.from([0x00, 0x02, 0x01, 239, ignition, 0x01, 66, 0x2e, 0xe0, 0x00, 0x00]));
  const body = Buffer.concat([rec, ...parts]);
  const array = Buffer.concat([Buffer.from([CODEC_8, 0x01]), body, Buffer.from([0x01])]);
  return encodeTcpPacket(array);
}

function startDevice(index: number) {
  const imei = String(860000000000000 + index).slice(0, 15);
  const sock = net.connect(PORT, HOST);
  let acked = 0;
  sock.on('connect', () => sock.write(encodeImei(imei)));
  let loggedIn = false;
  let timer: NodeJS.Timeout;
  sock.on('data', (d) => {
    if (!loggedIn) {
      if (d[0] !== 0x01) { console.error(`device ${imei} rejected`); sock.destroy(); return; }
      loggedIn = true;
      const tick = () => sock.write(buildPacket(Date.now(), 1, Math.floor(Math.random() * 90)));
      tick();
      timer = setInterval(tick, INTERVAL);
    } else {
      acked++;
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => clearInterval(timer));
  return () => acked;
}

console.log(`Simulating ${DEVICES} devices -> ${HOST}:${PORT}, every ${INTERVAL}ms`);
const counters = Array.from({ length: DEVICES }, (_, i) => startDevice(i));
setInterval(() => {
  const total = counters.reduce((s, c) => s + c(), 0);
  console.log(`acks received: ${total}`);
}, 5000);
