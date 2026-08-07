# Teltonika Ingestion Prototype (FTC927)

A **working, tested** proof-of-concept of the protocol-critical ingest path: the
riskiest, most hardware-specific piece of the platform, proven end-to-end before
the rest is built. See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §4.

It implements the verified FTC927 contract:

- IMEI login (`0x000F` + 15 digits) → allow-list → `0x01` accept / `0x00` reject
- **Codec 8** (`0x08`) and **Codec 8 Extended** (`0x8E`) AVL decoding
- **CRC-16/IBM** (poly `0xA001`) validation over the data field
- TCP framing for fragmented **and** coalesced segments
- **4-byte record-count ack**, sent **only after the sink persists** (the device
  clears flash on ack — premature ack = data loss)
- CRC/framing error ⇒ drop socket **without** ack ⇒ device resends
- FTC927 AVL-ID → domain-field mapping (fw 3.0.7+ subset)

Codec 16 (`0x10`) is detected and cleanly rejected (not yet implemented).

## Requirements

Node ≥ 22 (uses native TypeScript execution — no build step). Verified on Node
v24. No third-party dependencies.

## Test (proves it works)

```bash
npm test
```

Expected: **11 passing**. The decoder tests use Teltonika's **own** published
sample packets from the Codec wiki — the CRC test asserts the vendor checksum
`0xC7CF`, so a pass means our parser agrees with the vendor byte-for-byte. The
e2e tests stand up a real TCP server and play a device session through it.

## Run the server + simulate a device

```bash
# terminal 1 — server (allow all IMEIs if ALLOWED_IMEIS unset)
PORT=5027 npm start

# terminal 2 — send the vendor sample packet as a device would
node -e '
const net=require("net");
const imei=Buffer.concat([Buffer.from([0,15]),Buffer.from("356307042441013")]);
const pkt=Buffer.from("000000000000003608010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E0000000000000000010000C7CF","hex");
const s=net.connect(5027,"127.0.0.1",()=>{s.write(imei);setTimeout(()=>s.write(pkt),50);});
s.on("data",d=>console.log("server->device:",d.toString("hex")));
setTimeout(()=>s.end(),400);
'
```

You'll see the server log the accepted IMEI and the decoded record, and the
device receive `01` (accept) then `00000001` (ack of 1 record).

## Layout

```
src/codec/crc16.ts            CRC-16/IBM
src/codec/imei.ts             login frame parse + accept/reject
src/codec/teltonika-codec.ts  Codec 8 / 8E decode, framing, ack builder
src/avl-ids.ts                FTC927 AVL-ID → domain mapping
src/server/tcp-server.ts      TCP server (handshake → decode → ack)
test/codec.test.ts            unit tests vs vendor vectors
test/server.e2e.test.ts       live-socket handshake/decode/ack
```

## What this PoC intentionally stubs (productionized in `services/ingestion`)

- Durable sink (Kafka/Redpanda/Redis Stream) — here it's an in-memory callback
- Dedupe on `(imei, ts, hash)` for Duplicate-server mode and resends
- TLS/DTLS termination (device certs), UDP listener
- Codec 12 downlink, tachograph slow-path
```
