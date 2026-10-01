// apps/api/src/lib/seal.ts
// Envelope for KYC fields (id number, next of kin). AES-256-GCM with a key derived from
// KYC_ENCRYPTION_KEY, and the key id carried in the ciphertext so a rotated key can still open
// a seven-year-old record (env.ts KYC_ENCRYPTION_KEY_ID).
//
//   byte 0        version (1)
//   byte 1        key-id length n
//   bytes 2..2+n  key id (utf8)
//   next 12       IV
//   next 16       GCM tag
//   rest          ciphertext

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function derive(secret: string): Buffer {
  return createHash('sha256').update(`sidequest:kyc:v1:${secret}`).digest();
}

export function seal(plain: string, secret: string, keyId: string): Buffer {
  const kid = Buffer.from(keyId, 'utf8');
  if (kid.length > 255) throw new Error('key id too long');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(secret), iv);
  cipher.setAAD(kid);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1, kid.length]), kid, iv, cipher.getAuthTag(), ct]);
}

/** `keys` maps key id → secret, so records sealed under a retired key stay readable. */
export function open(envelope: Buffer, keys: Record<string, string>): string {
  if (envelope[0] !== 1) throw new Error('unknown envelope version');
  const n = envelope[1]!;
  const kid = envelope.subarray(2, 2 + n);
  const secret = keys[kid.toString('utf8')];
  if (!secret) throw new Error(`no key for id ${kid.toString('utf8')}`);
  const iv = envelope.subarray(2 + n, 14 + n);
  const tag = envelope.subarray(14 + n, 30 + n);
  const decipher = createDecipheriv('aes-256-gcm', derive(secret), iv);
  decipher.setAAD(kid);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(envelope.subarray(30 + n)), decipher.final()]).toString('utf8');
}
