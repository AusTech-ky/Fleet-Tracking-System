import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, totp, verifyTotp, generateSecret, otpauthUri } from '../src/engine/totp';

// RFC 6238 test secret: ASCII "12345678901234567890" (20 bytes), SHA1.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('base32 round-trips', () => {
  assert.equal(base32Decode(base32Encode(Buffer.from('12345678901234567890'))).toString(), '12345678901234567890');
  assert.equal(base32Encode(Buffer.from('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('TOTP matches RFC 6238 vectors (6-digit)', () => {
  // 8-digit RFC vectors truncated to 6 digits.
  assert.equal(totp(RFC_SECRET, 59_000), '287082');           // T=59
  assert.equal(totp(RFC_SECRET, 1_111_111_109_000), '081804'); // T=1111111109
  assert.equal(totp(RFC_SECRET, 1_234_567_890_000), '005924'); // T=1234567890
});

test('verifyTotp accepts the current code and tolerates ±1 step drift', () => {
  const t = 1_111_111_109_000;
  assert.equal(verifyTotp(RFC_SECRET, totp(RFC_SECRET, t), t), true);
  assert.equal(verifyTotp(RFC_SECRET, totp(RFC_SECRET, t - 30_000), t), true, 'previous step ok');
  assert.equal(verifyTotp(RFC_SECRET, totp(RFC_SECRET, t + 30_000), t), true, 'next step ok');
  assert.equal(verifyTotp(RFC_SECRET, totp(RFC_SECRET, t + 90_000), t), false, 'far-off step rejected');
  assert.equal(verifyTotp(RFC_SECRET, '000000', t), false);
});

test('generateSecret produces a decodable 20-byte base32 secret', () => {
  const s = generateSecret();
  assert.equal(base32Decode(s).length, 20);
});

test('otpauthUri is a valid provisioning URI', () => {
  const uri = otpauthUri('ABC234', 'user@acme.ky', 'FleetView');
  assert.match(uri, /^otpauth:\/\/totp\/FleetView%3Auser%40acme.ky\?/);
  assert.match(uri, /secret=ABC234/);
  assert.match(uri, /issuer=FleetView/);
});
