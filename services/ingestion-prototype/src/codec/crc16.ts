/**
 * CRC-16/IBM (a.k.a. CRC-16/ARC) as used by the Teltonika AVL protocol.
 *
 * Teltonika computes the CRC over the "data field" — every byte from the
 * Codec ID up to and including the second "Number of Data" byte. Polynomial
 * 0xA001 (reflected 0x8005), initial value 0x0000, no final XOR.
 *
 * Documented at https://wiki.teltonika-gps.com/view/Codec (see "CRC-16").
 */
export function crc16IBM(data: Buffer): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x0001) {
        crc = (crc >>> 1) ^ 0xa001;
      } else {
        crc >>>= 1;
      }
    }
  }
  return crc & 0xffff;
}
