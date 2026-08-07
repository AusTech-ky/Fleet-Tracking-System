import { crc16IBM } from './crc16.ts';
import { Reader } from './reader.ts';

/**
 * Teltonika AVL codec — Codec 8 (0x08) and Codec 8 Extended (0x8E).
 * Codec 16 (0x10) is detected and rejected: it is used only by FMB630/FM63XY
 * (adds a "Generation Type" byte) and is NOT used by the FTC927. Add a decoder
 * via the adapter layer when such hardware is onboarded (see ARCHITECTURE §20).
 * Source: https://wiki.teltonika-gps.com/view/Codec
 */
export const CODEC_8 = 0x08;
export const CODEC_8_EXT = 0x8e;
export const CODEC_16 = 0x10;

export interface GpsElement {
  longitude: number;
  latitude: number;
  altitude: number;
  angle: number;
  satellites: number;
  speed: number;
}
export interface IoElement {
  eventId: number;
  values: Record<number, number | bigint>;
  variable?: Record<number, Buffer>;
}
export interface AvlRecord {
  timestamp: Date;
  priority: number;
  gps: GpsElement;
  io: IoElement;
}
export interface DecodedAvl {
  codecId: number;
  recordCount: number;
  records: AvlRecord[];
}

export class TeltonikaDecodeError extends Error {}

/**
 * Decode the AVL *data array* (Codec ID .. second count byte). This is shared
 * by TCP (which wraps it with preamble+len+CRC) and UDP (which wraps it in a
 * UDP channel header, no CRC). See decodeTcpPacket / udp.ts.
 */
export function decodeAvlArray(dataField: Buffer): DecodedAvl {
  const r = new Reader(dataField);
  const codecId = r.u8();
  const recordCount = r.u8();

  if (codecId === CODEC_16) throw new TeltonikaDecodeError('Codec 16 not supported (FMB630/FM63XY only, not FTC927)');
  if (codecId !== CODEC_8 && codecId !== CODEC_8_EXT) {
    throw new TeltonikaDecodeError(`Unsupported codec 0x${codecId.toString(16)}`);
  }
  const extended = codecId === CODEC_8_EXT;

  const records: AvlRecord[] = [];
  for (let i = 0; i < recordCount; i++) records.push(readRecord(r, extended));

  const trailing = r.u8();
  if (trailing !== recordCount) {
    throw new TeltonikaDecodeError(`Record count mismatch: ${recordCount} vs ${trailing}`);
  }
  return { codecId, recordCount, records };
}

function readRecord(r: Reader, extended: boolean): AvlRecord {
  const timestamp = new Date(Number(r.u64()));
  const priority = r.u8();
  const gps: GpsElement = {
    longitude: r.i32() / 1e7,
    latitude: r.i32() / 1e7,
    altitude: r.i16(),
    angle: r.u16(),
    satellites: r.u8(),
    speed: r.u16(),
  };
  const eventId = extended ? r.u16() : r.u8();
  void (extended ? r.u16() : r.u8()); // total IO count (informational)

  const values: Record<number, number | bigint> = {};
  const readGroup = (width: 1 | 2 | 4 | 8) => {
    const n = extended ? r.u16() : r.u8();
    for (let i = 0; i < n; i++) {
      const id = extended ? r.u16() : r.u8();
      values[id] = width === 1 ? r.u8() : width === 2 ? r.u16() : width === 4 ? r.u32() : r.u64();
    }
  };
  readGroup(1);
  readGroup(2);
  readGroup(4);
  readGroup(8);

  const io: IoElement = { eventId, values };
  if (extended) {
    const nx = r.u16();
    if (nx > 0) {
      io.variable = {};
      for (let i = 0; i < nx; i++) {
        const id = r.u16();
        const len = r.u16();
        io.variable[id] = Buffer.from(r.bytes(len));
      }
    }
  }
  return { timestamp, priority, gps, io };
}

/** Decode a full TCP frame (preamble .. CRC). Verifies CRC. */
export function decodeTcpPacket(frame: Buffer): DecodedAvl {
  if (frame.length < 12) throw new TeltonikaDecodeError('Frame too short');
  if (frame.readUInt32BE(0) !== 0) throw new TeltonikaDecodeError('Bad preamble');
  const dataLen = frame.readUInt32BE(4);
  const dataField = frame.subarray(8, 8 + dataLen);
  if (dataField.length !== dataLen) throw new TeltonikaDecodeError('Incomplete data field');
  const crcExpected = frame.readUInt32BE(8 + dataLen) & 0xffff;
  const crcActual = crc16IBM(dataField);
  if (crcActual !== crcExpected) {
    throw new TeltonikaDecodeError(
      `CRC mismatch: computed 0x${crcActual.toString(16)} expected 0x${crcExpected.toString(16)}`,
    );
  }
  return decodeAvlArray(dataField);
}

/** TCP acknowledgement: 4-byte big-endian count of accepted records. */
export function buildTcpAck(recordCount: number): Buffer {
  const ack = Buffer.alloc(4);
  ack.writeUInt32BE(recordCount, 0);
  return ack;
}

/**
 * TCP stream framing. Returns the first complete frame + rest, or null if a
 * whole frame isn't buffered yet. Frame = 8 + dataLen + 4.
 */
export function extractFrame(buf: Buffer): { frame: Buffer; rest: Buffer } | null {
  if (buf.length < 8) return null;
  const dataLen = buf.readUInt32BE(4);
  const total = 8 + dataLen + 4;
  if (buf.length < total) return null;
  return { frame: buf.subarray(0, total), rest: buf.subarray(total) };
}

/** Wrap an AVL data array in a TCP frame (preamble+len+data+CRC). For tests/sim. */
export function encodeTcpPacket(dataArray: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(dataArray.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt16BE(crc16IBM(dataArray), 2);
  return Buffer.concat([Buffer.alloc(4), len, dataArray, crc]);
}
