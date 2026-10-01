// The phone and the server must agree byte for byte, or every fix fails verification on the
// receiving phone. Cross-check the RN implementation (noble) against the domain's (Node crypto).
import { createPublicKey, createPrivateKey } from 'crypto';
import { newKeyPair, deriveSecret, linkHash, tagFix, verifyTag, toB64, fromB64 } from './link';
import * as Node from '../../../../packages/domain/src/errand/link-handshake';

jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => Uint8Array.from(require('crypto').randomBytes(n)) }));

const errandId = '11111111-1111-4111-8111-111111111111';
const fix = { lat: -1.264123, lng: 36.751987, accuracyM: 8.4, headingDeg: 91.6, recordedAt: '2026-09-30T10:00:00.000Z' };

function nodePrivate(raw: Uint8Array) {
  // PKCS#8 prefix for a raw X25519 private key.
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(raw)]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

test('X25519 shared secret, link hash and fix tag match Node exactly', () => {
  const req = newKeyPair(), run = newKeyPair();
  const phone = deriveSecret(req.secretKey, run.publicKey);
  const server = Node.deriveSecret(nodePrivate(run.secretKey), Buffer.from(req.publicKey));
  expect(Buffer.from(phone).equals(server)).toBe(true);

  expect(Buffer.from(linkHash(req.publicKey, run.publicKey, errandId))
    .equals(Node.linkHash(Buffer.from(req.publicKey), Buffer.from(run.publicKey), errandId))).toBe(true);

  const tagPhone = tagFix(phone, errandId, 42, fix);
  expect(Buffer.from(tagPhone).equals(Node.tagFix(server, errandId, 42, fix))).toBe(true);
  expect(verifyTag(phone, errandId, 42, fix, tagPhone)).toBe(true);
  expect(verifyTag(phone, errandId, 42, { ...fix, lat: -1.3 }, tagPhone)).toBe(false);
  expect(verifyTag(phone, errandId, 43, fix, tagPhone)).toBe(false);
  void createPublicKey;
});

test('base64 round-trips and matches Buffer', () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33]) {
    const b = Uint8Array.from(require('crypto').randomBytes(n));
    expect(toB64(b)).toBe(Buffer.from(b).toString('base64'));
    expect(Buffer.from(fromB64(toB64(b))).equals(Buffer.from(b))).toBe(true);
  }
});
