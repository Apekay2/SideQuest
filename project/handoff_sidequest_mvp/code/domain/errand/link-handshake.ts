// packages/domain/src/errand/link-handshake.ts
// The link handshake: establishes, between one requester and one runner, the right to see
// each other's location for one errand — and authenticates every position fix.
//
// It does NOT release a task. Handover stays with the server-issued QR token.
// It does NOT move money. Spend authority stays with the card and the ladder.

import { createHash, createHmac, timingSafeEqual, diffieHellman,
         generateKeyPairSync, createPublicKey, type KeyObject } from 'node:crypto';

export interface KeyPair { publicKey: KeyObject; privateKey: KeyObject }

export function generateDeviceKeys(): KeyPair {
  return generateKeyPairSync('x25519');
}

export function rawPublicKey(key: KeyObject): Buffer {
  // 32-byte raw X25519 point, sliced out of the DER SubjectPublicKeyInfo prefix.
  return key.export({ type: 'spki', format: 'der' }).subarray(-32);
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error(`X25519 public key must be 32 bytes, got ${raw.length}`);
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
}

/** Derived on each device. The server never sees this. */
export function deriveSecret(ownPrivate: KeyObject, peerPublicRaw: Buffer): Buffer {
  const shared = diffieHellman({ privateKey: ownPrivate, publicKey: publicKeyFromRaw(peerPublicRaw) });
  return createHash('sha256').update(shared).digest();
}

/**
 * The hashed token. Both devices compute it independently; the server stores it and can
 * confirm the two sides agree without ever holding the secret. Public key order is fixed
 * (requester, then runner) so the two sides cannot disagree by accident.
 */
export function linkHash(requesterPubRaw: Buffer, runnerPubRaw: Buffer, errandId: string): Buffer {
  return createHash('sha256')
    .update(requesterPubRaw)
    .update(runnerPubRaw)
    .update(errandId, 'utf8')
    .digest();
}

export type LinkState =
  | 'pending_keys'      // one or both public keys missing
  | 'pending_ack'       // keys exchanged, handshake not yet confirmed by both
  | 'active'
  | 'revoked';

export function linkState(row: {
  requesterPub: Buffer | null;
  runnerPub: Buffer | null;
  requesterAckAt: Date | null;
  runnerAckAt: Date | null;
  revokedAt: Date | null;
}): LinkState {
  if (row.revokedAt) return 'revoked';
  if (!row.requesterPub || !row.runnerPub) return 'pending_keys';
  if (!row.requesterAckAt || !row.runnerAckAt) return 'pending_ack';
  return 'active';
}

/** Location sharing is refused outside 'active'. There is no partial state. */
export function mayShareLocation(state: LinkState): boolean {
  return state === 'active';
}

// ─────────────────────────────────────────── position fixes

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number;
  headingDeg: number | null;
  recordedAt: string; // ISO 8601
}

/** Canonical form so both platforms produce byte-identical input to the HMAC. */
function canonical(fix: Fix): string {
  return JSON.stringify({
    lat: Number(fix.lat.toFixed(6)),
    lng: Number(fix.lng.toFixed(6)),
    accuracyM: Math.round(fix.accuracyM),
    headingDeg: fix.headingDeg === null ? null : Math.round(fix.headingDeg),
    recordedAt: fix.recordedAt,
  });
}

export function tagFix(secret: Buffer, errandId: string, seq: number, fix: Fix): Buffer {
  return createHmac('sha256', secret)
    .update(canonical(fix))
    .update('\u0000')
    .update(errandId, 'utf8')
    .update('\u0000')
    .update(String(seq))
    .digest();
}

export type FixRejection = 'bad_tag' | 'stale_seq' | 'link_inactive';

/**
 * Runs on the RECEIVING device before anything is drawn on a map. A fix that fails here is
 * discarded, not merely flagged — the peer, not the server, is the authority on whether a
 * position came from the phone it claims to.
 */
export function verifyFix(args: {
  secret: Buffer;
  errandId: string;
  seq: number;
  fix: Fix;
  tag: Buffer;
  lastAcceptedSeq: number;
  state: LinkState;
}): { ok: true } | { ok: false; reason: FixRejection } {
  if (!mayShareLocation(args.state)) return { ok: false, reason: 'link_inactive' };
  if (args.seq <= args.lastAcceptedSeq) return { ok: false, reason: 'stale_seq' };

  const expected = tagFix(args.secret, args.errandId, args.seq, args.fix);
  if (expected.length !== args.tag.length || !timingSafeEqual(expected, args.tag)) {
    return { ok: false, reason: 'bad_tag' };
  }
  return { ok: true };
}

// ─────────────────────────────────────────── offline presentation

export const STALE_AFTER_MS = 90_000;

export type PresenceLabel = 'live' | 'linked_stale' | 'revoked';

/**
 * A runner in a dead zone is a KNOWN runner whose position is old. Never "unknown" —
 * the link is derived, so it survives both parties being offline.
 */
export function presence(state: LinkState, lastFixAtMs: number | null, nowMs = Date.now()): PresenceLabel {
  if (state === 'revoked') return 'revoked';
  if (lastFixAtMs !== null && nowMs - lastFixAtMs <= STALE_AFTER_MS) return 'live';
  return 'linked_stale';
}
