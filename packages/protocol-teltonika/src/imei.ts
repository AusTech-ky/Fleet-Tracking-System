/**
 * Teltonika IMEI login frame (TCP).
 * Device sends: 2-byte BE length (0x000F = 15) + 15 ASCII digits.
 * Server replies with one byte: 0x01 accept, 0x00 reject.
 * Source: https://wiki.teltonika-gps.com/view/Codec ("Communication with server")
 */
export const ACCEPT = Buffer.from([0x01]);
export const REJECT = Buffer.from([0x00]);

export interface ImeiParseResult {
  imei: string;
  bytesConsumed: number;
}

export function parseImei(buf: Buffer): ImeiParseResult | null {
  if (buf.length < 2) return null;
  const len = buf.readUInt16BE(0);
  if (len !== 15) throw new Error(`Unexpected IMEI length ${len} (expected 15)`);
  if (buf.length < 2 + len) return null;
  const imei = buf.subarray(2, 2 + len).toString('ascii');
  if (!/^\d{15}$/.test(imei)) throw new Error(`IMEI is not 15 digits: "${imei}"`);
  return { imei, bytesConsumed: 2 + len };
}

/** Encode an IMEI login frame (used by the device simulator / tests). */
export function encodeImei(imei: string): Buffer {
  if (!/^\d{15}$/.test(imei)) throw new Error('IMEI must be 15 digits');
  return Buffer.concat([Buffer.from([0x00, 0x0f]), Buffer.from(imei, 'ascii')]);
}
