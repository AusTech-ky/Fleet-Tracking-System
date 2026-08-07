import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crc16IBM,
  decodeTcpPacket,
  encodeTcpPacket,
  decodeAvlArray,
  CODEC_8_EXT,
  encodeCommand,
  decodeCodec12,
  TYPE_COMMAND,
  TYPE_RESPONSE,
  decodeUdpDatagram,
  buildUdpAck,
} from '../src/index.ts';

// --- Vendor test vectors (Teltonika Codec wiki) -----------------------------

const TCP_CODEC8 =
  '000000000000003608010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E0000000000000000010000C7CF';

// Codec 12 "getinfo" command, canonical vendor example (CRC 0x4312).
const CODEC12_GETINFO = '000000000000000F0C010500000007676574696E666F0100004312';

// Codec 8 over UDP, vendor example. IMEI 352093086403655, packet id 0xCAFE.
const UDP_SAMPLE =
  '003DCAFE0105000F33353230393330383634303336353508010000016B4F815B30010000000000000000000000000000000103021503010101425DBC000001';

test('TCP: decodes vendor Codec 8 packet and CRC = 0xC7CF', () => {
  const frame = Buffer.from(TCP_CODEC8, 'hex');
  const dataLen = frame.readUInt32BE(4);
  assert.equal(crc16IBM(frame.subarray(8, 8 + dataLen)), 0xc7cf);
  const pkt = decodeTcpPacket(frame);
  assert.equal(pkt.recordCount, 1);
  assert.equal(pkt.records[0].io.values[21], 3); // GSM signal
});

test('TCP: encode/decode round-trips an 8E array', () => {
  // 8E zero-IO record: ts8+prio1+gps15(=24) + evt2+total2 + n1/n2/n4/n8(4x2=8)
  // + variable-group count nx2 = 38 bytes, all zero except the timestamp.
  const rec = Buffer.alloc(24 + 2 + 2 + 8 + 2);
  rec.writeBigUInt64BE(1700000000000n, 0);
  const array = Buffer.concat([Buffer.from([CODEC_8_EXT, 1]), rec, Buffer.from([1])]);
  const frame = encodeTcpPacket(array);
  const decoded = decodeTcpPacket(frame);
  assert.equal(decoded.codecId, CODEC_8_EXT);
  assert.equal(decoded.recordCount, 1);
  assert.equal(decoded.records[0].timestamp.getTime(), 1700000000000);
});

test('Codec 12: encodeCommand matches vendor getinfo vector byte-for-byte', () => {
  assert.equal(encodeCommand('getinfo').toString('hex'), CODEC12_GETINFO.toLowerCase());
});

test('Codec 12: decodes the getinfo command back', () => {
  const msg = decodeCodec12(Buffer.from(CODEC12_GETINFO, 'hex'));
  assert.equal(msg.type, TYPE_COMMAND);
  assert.equal(msg.payload, 'getinfo');
});

test('Codec 12: decodes a device response (type 0x06)', () => {
  // Synthesize a response using the encoder shape but flipping the type byte.
  const cmd = encodeCommand('Device online'); // reuse framing
  const frame = Buffer.from(cmd);
  // find the type byte: preamble(4)+size(4)+codec(1)+qty1(1) => index 10
  frame[10] = TYPE_RESPONSE;
  // recompute CRC over data field
  const size = frame.readUInt32BE(4);
  const df = frame.subarray(8, 8 + size);
  frame.writeUInt16BE(crc16IBM(df), 8 + size + 2);
  const msg = decodeCodec12(frame);
  assert.equal(msg.type, TYPE_RESPONSE);
  assert.equal(msg.payload, 'Device online');
});

test('UDP: decodes vendor datagram (imei, packet ids, 1 record)', () => {
  const d = decodeUdpDatagram(Buffer.from(UDP_SAMPLE, 'hex'));
  assert.equal(d.imei, '352093086403655');
  assert.equal(d.packetId, 0xcafe);
  assert.equal(d.avlPacketId, 0x05);
  assert.equal(d.avl.recordCount, 1);
});

test('UDP: ack echoes packet id + avl packet id + accepted count', () => {
  const ack = buildUdpAck(0xcafe, 0x05, 1);
  assert.equal(ack.toString('hex'), '0005cafe010501');
});

test('AVL array decoder rejects Codec 16 with a clear message', () => {
  assert.throws(() => decodeAvlArray(Buffer.from([0x10, 0x00, 0x00])), /Codec 16 not supported/);
});
