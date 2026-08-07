import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) for multi-factor auth — compatible with Google Authenticator,
 * Authy, 1Password, etc. HMAC-SHA1, 30-second step, 6 digits. Pure (framework-
 * and DB-free) and verified against the RFC 6238 test vectors.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh base32 MFA secret (160-bit, per RFC recommendation). */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Compute the TOTP code for a base32 secret at a given time. */
export function totp(secretBase32: string, timeMs: number, step = 30, digits = 6): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

/** Verify a code, allowing ±`window` steps of clock drift. Constant-time compare. */
export function verifyTotp(secretBase32: string, code: string, timeMs: number, window = 1): boolean {
  const target = Buffer.from(code.padStart(6, '0'));
  for (let w = -window; w <= window; w++) {
    const candidate = Buffer.from(totp(secretBase32, timeMs + w * 30_000));
    if (candidate.length === target.length && timingSafeEqual(candidate, target)) return true;
  }
  return false;
}

/** otpauth:// provisioning URI (encode as a QR for authenticator apps). */
export function otpauthUri(secretBase32: string, account: string, issuer = 'FleetView'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
