import { decodeAvlArray, type DecodedAvl } from './codec8.ts';

/**
 * Codec 8/8E over UDP. Unlike TCP there is NO preamble and NO CRC — the UDP
 * datagram provides framing. Reliability comes from an application-level ack
 * that echoes the packet id.
 *
 * Incoming datagram:
 *   Length(2) | PacketID(2) | NotUsableByte(1) | Payload
 *   Payload = AvlPacketID(1) | IMEILength(2=0x000F) | IMEI(15) | AVL Data Array
 * Server response:
 *   Length(2)=0x0005 | PacketID(2, echo) | NotUsableByte(1)=0x01 |
 *   AvlPacketID(1) | NumberOfAcceptedRecords(1)
 * Source: https://wiki.teltonika-gps.com/view/Codec ("Codec8 protocol sending over UDP")
 */

export class UdpDecodeError extends Error {}

export interface DecodedUdp {
  packetId: number; // UDP channel packet id (echo in ack)
  avlPacketId: number; // AVL packet id (echo in ack)
  imei: string;
  avl: DecodedAvl;
}

export function decodeUdpDatagram(dgram: Buffer): DecodedUdp {
  if (dgram.length < 5) throw new UdpDecodeError('Datagram too short');
  const length = dgram.readUInt16BE(0);
  if (dgram.length !== length + 2) {
    throw new UdpDecodeError(`Length mismatch: header ${length}, datagram has ${dgram.length - 2}`);
  }
  const packetId = dgram.readUInt16BE(2);
  // dgram[4] = not-usable byte
  const avlPacketId = dgram.readUInt8(5);
  const imeiLen = dgram.readUInt16BE(6);
  if (imeiLen !== 15) throw new UdpDecodeError(`Unexpected IMEI length ${imeiLen}`);
  const imei = dgram.subarray(8, 8 + 15).toString('ascii');
  if (!/^\d{15}$/.test(imei)) throw new UdpDecodeError(`Bad IMEI "${imei}"`);
  const avlArray = dgram.subarray(8 + 15); // remainder = AVL data array (no CRC)
  const avl = decodeAvlArray(avlArray);
  return { packetId, avlPacketId, imei, avl };
}

export function buildUdpAck(packetId: number, avlPacketId: number, acceptedCount: number): Buffer {
  const body = Buffer.alloc(7);
  body.writeUInt16BE(0x0005, 0); // length of the remaining 5 bytes
  body.writeUInt16BE(packetId, 2);
  body.writeUInt8(0x01, 4); // not-usable byte
  body.writeUInt8(avlPacketId, 5);
  body.writeUInt8(acceptedCount & 0xff, 6);
  return body;
}
