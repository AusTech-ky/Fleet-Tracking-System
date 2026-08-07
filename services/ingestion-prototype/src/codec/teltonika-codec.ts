import { crc16IBM } from './crc16.ts';

/**
 * Teltonika AVL data packet decoder — Codec 8 (0x08) and Codec 8 Extended
 * (0x8E). Codec 16 (0x10) is detected and rejected here with a clear error so
 * the ingestion layer degrades gracefully until a Codec 16 decoder is added.
 *
 * Packet layout (documented at https://wiki.teltonika-gps.com/view/Codec):
 *
 *   Preamble        4 bytes   always 0x00000000
 *   Data Length     4 bytes   length of the Data Field (Codec ID .. 2nd count)
 *   --- Data Field (this is what the CRC covers) ---
 *   Codec ID        1 byte    0x08 | 0x8E | 0x10
 *   Number of Data  1 byte    record count (N1)
 *   AVL records     variable
 *   Number of Data  1 byte    must equal N1
 *   ------------------------------------------------
 *   CRC-16          4 bytes   low 16 bits = CRC-16/IBM over the Data Field
 *
 * All multi-byte integers are big-endian. GPS lat/lon are int32 scaled by 1e7.
 */

export const CODEC_8 = 0x08;
export const CODEC_8_EXT = 0x8e;
export const CODEC_16 = 0x10;

export interface GpsElement {
  longitude: number; // decimal degrees
  latitude: number; // decimal degrees
  altitude: number; // meters
  angle: number; // degrees 0..360
  satellites: number;
  speed: number; // km/h
}

export interface IoElement {
  eventId: number; // AVL ID that triggered the record (0 = periodic)
  /** map of AVL ID -> raw integer value (as a JS number or bigint for 8-byte) */
  values: Record<number, number | bigint>;
  /** variable-length elements (Codec 8E only): AVL ID -> raw bytes */
  variable?: Record<number, Buffer>;
}

export interface AvlRecord {
  timestamp: Date;
  priority: number; // 0 low, 1 high, 2 panic
  gps: GpsElement;
  io: IoElement;
}

export interface DecodedPacket {
  codecId: number;
  recordCount: number;
  records: AvlRecord[];
}

class Reader {
  private readonly buf: Buffer;
  public offset: number;
  constructor(buf: Buffer, offset = 0) {
    this.buf = buf;
    this.offset = offset;
  }
  u8() { return this.buf.readUInt8(this.offset++); }
  u16() { const v = this.buf.readUInt16BE(this.offset); this.offset += 2; return v; }
  u32() { const v = this.buf.readUInt32BE(this.offset); this.offset += 4; return v; }
  i16() { const v = this.buf.readInt16BE(this.offset); this.offset += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.offset); this.offset += 4; return v; }
  u64() { const v = this.buf.readBigUInt64BE(this.offset); this.offset += 8; return v; }
  i64() { const v = this.buf.readBigInt64BE(this.offset); this.offset += 8; return v; }
  bytes(n: number) { const v = this.buf.subarray(this.offset, this.offset + n); this.offset += n; return v; }
}

export class TeltonikaDecodeError extends Error {}

/**
 * Decode a complete TCP AVL frame (preamble .. CRC). Throws on malformed data,
 * CRC mismatch, or record-count mismatch. The caller is responsible for TCP
 * framing (see extractFrame) — this function assumes exactly one full frame.
 */
export function decodeTcpPacket(frame: Buffer): DecodedPacket {
  if (frame.length < 12) throw new TeltonikaDecodeError('Frame too short');
  const preamble = frame.readUInt32BE(0);
  if (preamble !== 0) throw new TeltonikaDecodeError(`Bad preamble 0x${preamble.toString(16)}`);

  const dataLen = frame.readUInt32BE(4);
  const dataField = frame.subarray(8, 8 + dataLen);
  if (dataField.length !== dataLen) {
    throw new TeltonikaDecodeError(`Incomplete data field: have ${dataField.length}, need ${dataLen}`);
  }

  const crcExpected = frame.readUInt32BE(8 + dataLen) & 0xffff;
  const crcActual = crc16IBM(dataField);
  if (crcActual !== crcExpected) {
    throw new TeltonikaDecodeError(
      `CRC mismatch: computed 0x${crcActual.toString(16)} expected 0x${crcExpected.toString(16)}`,
    );
  }

  const r = new Reader(dataField);
  const codecId = r.u8();
  const recordCount = r.u8();

  if (codecId === CODEC_16) {
    throw new TeltonikaDecodeError('Codec 16 not yet supported by this prototype');
  }
  if (codecId !== CODEC_8 && codecId !== CODEC_8_EXT) {
    throw new TeltonikaDecodeError(`Unsupported codec 0x${codecId.toString(16)}`);
  }
  const extended = codecId === CODEC_8_EXT;

  const records: AvlRecord[] = [];
  for (let i = 0; i < recordCount; i++) {
    records.push(readRecord(r, extended));
  }

  const trailingCount = r.u8();
  if (trailingCount !== recordCount) {
    throw new TeltonikaDecodeError(`Record count mismatch: ${recordCount} vs ${trailingCount}`);
  }

  return { codecId, recordCount, records };
}

function readRecord(r: Reader, extended: boolean): AvlRecord {
  const ms = r.u64();
  const timestamp = new Date(Number(ms));
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
  const totalIo = extended ? r.u16() : r.u8(); // total count (informational)
  void totalIo;

  const values: Record<number, number | bigint> = {};

  // 1-byte values
  const n1 = extended ? r.u16() : r.u8();
  for (let i = 0; i < n1; i++) {
    const id = extended ? r.u16() : r.u8();
    values[id] = r.u8();
  }
  // 2-byte values
  const n2 = extended ? r.u16() : r.u8();
  for (let i = 0; i < n2; i++) {
    const id = extended ? r.u16() : r.u8();
    values[id] = r.u16();
  }
  // 4-byte values
  const n4 = extended ? r.u16() : r.u8();
  for (let i = 0; i < n4; i++) {
    const id = extended ? r.u16() : r.u8();
    values[id] = r.u32();
  }
  // 8-byte values
  const n8 = extended ? r.u16() : r.u8();
  for (let i = 0; i < n8; i++) {
    const id = extended ? r.u16() : r.u8();
    values[id] = r.u64();
  }

  const io: IoElement = { eventId, values };

  // Variable-length group (Codec 8 Extended only)
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

/**
 * Build the 4-byte big-endian acknowledgement the server must send back after
 * durably persisting the records. The device clears the acked records from its
 * flash storage; a wrong or missing value triggers a resend.
 */
export function buildAck(recordCount: number): Buffer {
  const ack = Buffer.alloc(4);
  ack.writeUInt32BE(recordCount, 0);
  return ack;
}

/**
 * TCP framing helper. Given an accumulating buffer, returns the first complete
 * AVL frame and the remaining bytes, or null if a full frame is not yet present.
 * Frame length = 8 (preamble+len) + dataLen + 4 (CRC).
 */
export function extractFrame(buf: Buffer): { frame: Buffer; rest: Buffer } | null {
  if (buf.length < 8) return null;
  const dataLen = buf.readUInt32BE(4);
  const total = 8 + dataLen + 4;
  if (buf.length < total) return null;
  return { frame: buf.subarray(0, total), rest: buf.subarray(total) };
}
