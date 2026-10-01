// apps/mobile/src/lib/link.ts
// The phone's half of the link handshake (01-architecture §1.9). Byte-for-byte the same
// derivations as packages/domain/src/errand/link-handshake.ts, which runs in Node on the
// server side of the tests; link.test.ts cross-checks the two.
//
//   secret    = SHA-256(X25519(own_private, peer_public))      never leaves the phone
//   link_hash = SHA-256(pub_requester ‖ pub_runner ‖ errand_id)
//   tag       = HMAC-SHA256(secret, canonical(fix) ‖ 0x00 ‖ errand_id ‖ 0x00 ‖ seq)
//
// Randomness comes from expo-crypto (the platform CSPRNG); Hermes has no crypto.getRandomValues.

import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as Crypto from 'expo-crypto';

export interface Fix { lat: number; lng: number; accuracyM: number; headingDeg: number | null; recordedAt: string }

export function newKeyPair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = Crypto.getRandomBytes(32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function deriveSecret(ownSecret: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  return sha256(x25519.getSharedSecret(ownSecret, peerPublic));
}

export function linkHash(requesterPub: Uint8Array, runnerPub: Uint8Array, errandId: string): Uint8Array {
  return sha256(concatBytes(requesterPub, runnerPub, utf8ToBytes(errandId)));
}

/** Canonical form so both platforms, and Node, produce identical HMAC input. */
function canonical(fix: Fix): string {
  return JSON.stringify({
    lat: Number(fix.lat.toFixed(6)),
    lng: Number(fix.lng.toFixed(6)),
    accuracyM: Math.round(fix.accuracyM),
    headingDeg: fix.headingDeg === null ? null : Math.round(fix.headingDeg),
    recordedAt: fix.recordedAt,
  });
}

export function tagFix(secret: Uint8Array, errandId: string, seq: number, fix: Fix): Uint8Array {
  const zero = new Uint8Array([0]);
  return hmac(sha256, secret, concatBytes(utf8ToBytes(canonical(fix)), zero, utf8ToBytes(errandId), zero, utf8ToBytes(String(seq))));
}

/** Constant-time compare; the receiving phone discards anything that fails. */
export function verifyTag(secret: Uint8Array, errandId: string, seq: number, fix: Fix, tag: Uint8Array): boolean {
  const want = tagFix(secret, errandId, seq, fix);
  if (want.length !== tag.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want[i]! ^ tag[i]!;
  return diff === 0;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toB64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=');
  }
  return out;
}
export function fromB64(s: string): Uint8Array {
  const clean = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, j) => (acc << 6) | (clean[i + j] ? B64.indexOf(clean[i + j]!) : 0), 0);
    out.push((n >> 16) & 255);
    if (clean[i + 2]) out.push((n >> 8) & 255);
    if (clean[i + 3]) out.push(n & 255);
  }
  return Uint8Array.from(out);
}
