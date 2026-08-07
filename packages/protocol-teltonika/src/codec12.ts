import { crc16IBM } from './crc16.ts';
import { Reader } from './reader.ts';

/**
 * Codec 12 — GPRS command/response channel (downlink to device).
 * Used to send config/output-control/debug commands over the SAME open socket
 * after AVL data has been sent and acked. The session must stay open (device
 * "active data link timeout" should be high).
 *
 * Command message:
 *   preamble(4) | dataSize(4) | 0x0C | qty1(1) | type=0x05(1) | cmdSize(4) |
 *   command(ASCII) | qty2(1) | CRC16(4)
 * Response message: identical but type=0x06 and payload is the response text.
 * dataSize = from Codec ID to qty2. CRC16/IBM over that same range.
 * Source: https://wiki.teltonika-gps.com/view/Codec ("Codec 12")
 */
export const CODEC_12 = 0x0c;
export const TYPE_COMMAND = 0x05;
export const TYPE_RESPONSE = 0x06;

export class Codec12Error extends Error {}

/** Encode a GPRS command (e.g. "getinfo", "setdigout 1") to send to the device. */
export function encodeCommand(command: string): Buffer {
  const cmd = Buffer.from(command, 'ascii');
  const cmdSize = Buffer.alloc(4);
  cmdSize.writeUInt32BE(cmd.length, 0);
  // data field: codecId | qty1 | type | cmdSize(4) | command | qty2
  const dataField = Buffer.concat([
    Buffer.from([CODEC_12, 0x01, TYPE_COMMAND]),
    cmdSize,
    cmd,
    Buffer.from([0x01]),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(dataField.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt16BE(crc16IBM(dataField), 2);
  return Buffer.concat([Buffer.alloc(4), size, dataField, crc]);
}

/** Encode a device-side response (type 0x06). Used by the device simulator/tests. */
export function encodeResponse(text: string): Buffer {
  const body = Buffer.from(text, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  const dataField = Buffer.concat([
    Buffer.from([CODEC_12, 0x01, TYPE_RESPONSE]),
    size,
    body,
    Buffer.from([0x01]),
  ]);
  const dataSize = Buffer.alloc(4);
  dataSize.writeUInt32BE(dataField.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt16BE(crc16IBM(dataField), 2);
  return Buffer.concat([Buffer.alloc(4), dataSize, dataField, crc]);
}

export interface Codec12Message {
  type: number; // 0x05 command | 0x06 response
  payload: string; // ASCII text
}

/** Decode a Codec 12 frame (command or response). Verifies CRC. */
export function decodeCodec12(frame: Buffer): Codec12Message {
  if (frame.length < 12) throw new Codec12Error('Frame too short');
  if (frame.readUInt32BE(0) !== 0) throw new Codec12Error('Bad preamble');
  const dataSize = frame.readUInt32BE(4);
  const dataField = frame.subarray(8, 8 + dataSize);
  if (dataField.length !== dataSize) throw new Codec12Error('Incomplete data field');
  const crcExpected = frame.readUInt32BE(8 + dataSize) & 0xffff;
  const crcActual = crc16IBM(dataField);
  if (crcActual !== crcExpected) {
    throw new Codec12Error(`CRC mismatch: 0x${crcActual.toString(16)} vs 0x${crcExpected.toString(16)}`);
  }
  const r = new Reader(dataField);
  const codecId = r.u8();
  if (codecId !== CODEC_12) throw new Codec12Error(`Not Codec 12 (0x${codecId.toString(16)})`);
  r.u8(); // qty1 (ignored per spec)
  const type = r.u8();
  const size = r.u32();
  const payload = r.bytes(size).toString('ascii');
  return { type, payload };
}

/** Full framing helper: is a complete Codec 12 frame present in the buffer? */
export function extractCodec12Frame(buf: Buffer): { frame: Buffer; rest: Buffer } | null {
  if (buf.length < 8) return null;
  const dataSize = buf.readUInt32BE(4);
  const total = 8 + dataSize + 4;
  if (buf.length < total) return null;
  return { frame: buf.subarray(0, total), rest: buf.subarray(total) };
}
