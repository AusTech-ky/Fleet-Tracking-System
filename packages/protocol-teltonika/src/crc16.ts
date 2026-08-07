/**
 * CRC-16/IBM (a.k.a. CRC-16/ARC) as used by the Teltonika AVL and Codec 12
 * protocols. Polynomial 0xA001 (reflected 0x8005), init 0x0000, no final XOR.
 * Computed over the "data field" (Codec ID .. second quantity/count byte).
 * Source: https://wiki.teltonika-gps.com/view/Codec
 */
export function crc16IBM(data: Buffer): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x0001 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}
