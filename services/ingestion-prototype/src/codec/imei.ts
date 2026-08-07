/**
 * Teltonika IMEI login frame.
 *
 * On connect the device sends: 2-byte big-endian length (always 0x000F = 15)
 * followed by the IMEI as 15 ASCII digits. The server replies with a single
 * byte: 0x01 = accept, 0x00 = reject.
 *
 * Documented at https://wiki.teltonika-gps.com/view/Codec ("Login").
 */
export const ACCEPT = Buffer.from([0x01]);
export const REJECT = Buffer.from([0x00]);

export interface ImeiParseResult {
  imei: string;
  /** total bytes consumed from the buffer (2 + length) */
  bytesConsumed: number;
}

/**
 * Parse an IMEI login frame. Returns null if the buffer does not yet hold a
 * complete frame (caller should wait for more bytes).
 */
export function parseImei(buf: Buffer): ImeiParseResult | null {
  if (buf.length < 2) return null;
  const len = buf.readUInt16BE(0);
  if (len !== 15) {
    throw new Error(`Unexpected IMEI length ${len} (expected 15)`);
  }
  if (buf.length < 2 + len) return null;
  const imei = buf.subarray(2, 2 + len).toString('ascii');
  if (!/^\d{15}$/.test(imei)) {
    throw new Error(`IMEI is not 15 digits: "${imei}"`);
  }
  return { imei, bytesConsumed: 2 + len };
}
