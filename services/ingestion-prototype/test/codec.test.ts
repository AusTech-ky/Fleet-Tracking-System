import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc16IBM } from '../src/codec/crc16.ts';
import { parseImei } from '../src/codec/imei.ts';
import {
  decodeTcpPacket,
  extractFrame,
  buildAck,
  CODEC_8,
  CODEC_8_EXT,
} from '../src/codec/teltonika-codec.ts';

/**
 * These hex strings are the canonical example packets published on the
 * Teltonika Codec wiki (https://wiki.teltonika-gps.com/view/Codec). Using the
 * vendor's own vectors is what makes this a *verification*, not a guess.
 */

// Codec 8, 1 record, ends with CRC 0x000C7CF.
const CODEC8_SAMPLE =
  '000000000000003608010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E0000000000000000010000C7CF';

// Codec 8 Extended, 1 record.
const CODEC8E_SAMPLE =
  '000000000000004A8E010000016B412CEE000100000000000000000000000000000000010005000100010100010011001D00010010015E2C880002000B000000003544C87A000E000000001DD7E06A00000100002994';

/**
 * Build a valid Codec 8 packet with `count` minimal (zero-IO) records and seal
 * it with a real CRC. crc16IBM is independently proven against the vendor
 * sample above, so using it here to frame a synthetic multi-record packet is
 * legitimate — it exercises the record loop and the count/trailing-count check.
 */
function buildCodec8(count: number): Buffer {
  const record = Buffer.alloc(30); // ts8 + prio1 + gps15 + evt1 + total1 + 4 zero group-counts
  record.writeBigUInt64BE(1600000000000n, 0);
  record[8] = 0; // priority
  // GPS + IO group counts all left zero
  const body = Buffer.concat(Array.from({ length: count }, () => record));
  const dataField = Buffer.concat([
    Buffer.from([CODEC_8, count]),
    body,
    Buffer.from([count]),
  ]);
  const crc = Buffer.alloc(4);
  crc.writeUInt16BE(crc16IBM(dataField), 2);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(dataField.length, 0);
  return Buffer.concat([Buffer.alloc(4), len, dataField, crc]);
}

test('CRC-16/IBM matches the vendor sample checksum', () => {
  const frame = Buffer.from(CODEC8_SAMPLE, 'hex');
  const dataLen = frame.readUInt32BE(4);
  const dataField = frame.subarray(8, 8 + dataLen);
  const expected = frame.readUInt32BE(8 + dataLen) & 0xffff;
  assert.equal(crc16IBM(dataField), expected);
  assert.equal(crc16IBM(dataField), 0xc7cf);
});

test('IMEI login frame parses to 15 digits', () => {
  // 000F + "356307042441013"
  const buf = Buffer.concat([
    Buffer.from([0x00, 0x0f]),
    Buffer.from('356307042441013', 'ascii'),
  ]);
  const res = parseImei(buf);
  assert.ok(res);
  assert.equal(res.imei, '356307042441013');
  assert.equal(res.bytesConsumed, 17);
});

test('IMEI parser waits for more bytes when frame is partial', () => {
  assert.equal(parseImei(Buffer.from([0x00])), null);
  assert.equal(parseImei(Buffer.from([0x00, 0x0f, 0x33])), null);
});

test('decodes Codec 8 sample: GPS + IO + counts', () => {
  const pkt = decodeTcpPacket(Buffer.from(CODEC8_SAMPLE, 'hex'));
  assert.equal(pkt.codecId, CODEC_8);
  assert.equal(pkt.recordCount, 1);
  const rec = pkt.records[0];
  // Timestamp 0x016B40D8EA30 = 1560166592048 ms -> 2019-06-10T...
  assert.equal(rec.timestamp.getTime(), 0x016b40d8ea30);
  assert.equal(rec.priority, 1);
  // GPS in this sample is all zeros (no fix yet).
  assert.equal(rec.gps.longitude, 0);
  assert.equal(rec.gps.latitude, 0);
  assert.equal(rec.gps.satellites, 0);
  // IO: event id 0x01 (ignition), a set of 1/2/4/8-byte elements present.
  assert.equal(rec.io.eventId, 0x01);
  // AVL ID 0x15=21 (GSM signal) present as a 1-byte value = 3.
  assert.equal(rec.io.values[21], 3);
  // AVL ID 0xF1=241 (GSM operator) present as a 4-byte value.
  assert.equal(rec.io.values[241], 0x0000601a);
});

test('decodes Codec 8 Extended sample', () => {
  const pkt = decodeTcpPacket(Buffer.from(CODEC8E_SAMPLE, 'hex'));
  assert.equal(pkt.codecId, CODEC_8_EXT);
  assert.equal(pkt.recordCount, 1);
  const rec = pkt.records[0];
  assert.equal(rec.priority, 1);
  // A successful decode implies the 1/2/4/8-byte IO groups were consumed with
  // the correct 2-byte-wide framing: otherwise the trailing record-count check
  // inside decodeTcpPacket would have thrown. At least one IO value was read.
  assert.ok(Object.keys(rec.io.values).length > 0);
});

test('decodes a multi-record Codec 8 packet', () => {
  const pkt = decodeTcpPacket(buildCodec8(5));
  assert.equal(pkt.recordCount, 5);
  assert.equal(pkt.records.length, 5);
  assert.equal(pkt.records[0].timestamp.getTime(), 1600000000000);
});

test('CRC mismatch is rejected', () => {
  const frame = Buffer.from(CODEC8_SAMPLE, 'hex');
  frame[frame.length - 1] ^= 0xff; // corrupt CRC
  assert.throws(() => decodeTcpPacket(frame), /CRC mismatch/);
});

test('buildAck encodes record count as 4-byte big-endian', () => {
  assert.deepEqual(buildAck(1), Buffer.from([0x00, 0x00, 0x00, 0x01]));
  assert.deepEqual(buildAck(258), Buffer.from([0x00, 0x00, 0x01, 0x02]));
});

test('extractFrame handles fragmented and coalesced TCP streams', () => {
  const whole = Buffer.from(CODEC8_SAMPLE, 'hex');
  // Fragmented: only part of the frame arrived.
  assert.equal(extractFrame(whole.subarray(0, 10)), null);
  // Two frames coalesced in one TCP segment (Nagle / batching).
  const two = Buffer.concat([whole, Buffer.from(CODEC8E_SAMPLE, 'hex')]);
  const first = extractFrame(two);
  assert.ok(first);
  assert.equal(first.frame.length, whole.length);
  const second = extractFrame(first.rest);
  assert.ok(second);
  assert.equal(second.rest.length, 0);
});
