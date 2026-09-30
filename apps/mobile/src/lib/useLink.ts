// apps/mobile/src/lib/useLink.ts
// Runs the link handshake and location sharing for one live errand, on either phone.
//
//  1. Generate (once per errand) an X25519 key pair; the private half lives in the keystore.
//  2. Publish the public key; wait for the counterpart's.
//  3. Derive the shared secret on-device, compute the link hash, post it as the ack.
//  4. Once both acks land: stream own fixes tagged with HMAC(secret, …); verify every fix
//     received before showing it. A fix that fails is discarded, not flagged (01 §1.9).
//
// The server never sees the secret; it confirms the two phones agree by comparing hashes.

import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import type { LinkState, LocationView } from '@sidequest/contracts';
import { api } from './api';
import { onRealtime } from './realtime';
import { secureStore } from '../platform/adaptive';
import { newKeyPair, deriveSecret, linkHash, tagFix, verifyTag, toB64, fromB64, type Fix } from './link';

const FIX_EVERY_MS = 15_000;

export interface PeerFix { lat: number; lng: number; at: string; verified: boolean }

async function keysFor(errandId: string) {
  const stored = await secureStore.get(`link:${errandId}`);
  if (stored) {
    const [sk, pk] = stored.split('.');
    return { secretKey: fromB64(sk!), publicKey: fromB64(pk!) };
  }
  const k = newKeyPair();
  await secureStore.set(`link:${errandId}`, `${toB64(k.secretKey)}.${toB64(k.publicKey)}`);
  return k;
}

export function useLink(errandId: string | undefined, role: 'requester' | 'runner' | null, live: boolean) {
  const [state, setState] = useState<LinkState['state'] | 'off'>('off');
  const [peer, setPeer] = useState<PeerFix | null>(null);
  const secret = useRef<Uint8Array | null>(null);
  const lastSeq = useRef(0);

  // Handshake.
  useEffect(() => {
    if (!errandId || !role || !live) return;
    let stop = false;
    (async () => {
      const k = await keysFor(errandId);
      let v = await api.post<LinkState>(`/errands/${errandId}/link`, { public_key: toB64(k.publicKey) }).catch(() => null);
      while (!stop && v && v.state !== 'active' && v.state !== 'revoked') {
        setState(v.state);
        if (v.counterpart_key) {
          const theirs = fromB64(v.counterpart_key);
          secret.current = deriveSecret(k.secretKey, theirs);
          const [reqPub, runPub] = role === 'requester' ? [k.publicKey, theirs] : [theirs, k.publicKey];
          v = await api.post<LinkState>(`/errands/${errandId}/link/ack`, { link_hash: toB64(linkHash(reqPub, runPub, errandId)) }).catch(() => v);
          if (v?.state === 'active') break;
        }
        await new Promise((r) => setTimeout(r, 3000));
        v = await api.get<LinkState>(`/errands/${errandId}/link`).catch(() => v);
      }
      if (!stop && v) {
        if (v.counterpart_key && !secret.current) secret.current = deriveSecret(k.secretKey, fromB64(v.counterpart_key));
        setState(v.state);
      }
    })();
    return () => { stop = true; };
  }, [errandId, role, live]);

  // Stream own fixes once active. Runner fixes are durable (they feed matching and ETA);
  // requester fixes are ephemeral and only relayed to the runner (06 §6.8).
  useEffect(() => {
    if (state !== 'active' || !errandId || !role) return;
    let sub: Location.LocationSubscription | null = null;
    let seq = Date.now() % 1_000_000_000;   // monotonic across restarts of this screen
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted || !secret.current) return;
      sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, timeInterval: FIX_EVERY_MS, distanceInterval: 10 }, (pos) => {
        const fix: Fix = {
          lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? 50,
          headingDeg: pos.coords.heading ?? null, recordedAt: new Date(pos.timestamp).toISOString(),
        };
        seq += 1;
        const body = { fixes: [{
          errand_id: errandId, lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracyM,
          heading_deg: fix.headingDeg !== null && fix.headingDeg >= 0 ? fix.headingDeg : null,
          seq, hmac_tag: toB64(tagFix(secret.current!, errandId, seq, { ...fix, headingDeg: fix.headingDeg !== null && fix.headingDeg >= 0 ? fix.headingDeg : null })),
          recorded_at: fix.recordedAt,
        }] };
        const path = role === 'runner' ? '/location' : `/errands/${errandId}/location/requester`;
        api.post(path, body).catch(() => undefined);   // queued fixes are dropped, not retried: the next one supersedes
      });
    })();
    return () => { sub?.remove(); };
  }, [state, errandId, role]);

  // Receive the counterpart's fixes: pushed over the socket, and (requester) polled as a floor.
  useEffect(() => {
    if (state !== 'active' || !errandId) return;
    const accept = (f: { lat: number; lng: number; accuracy_m: number | null; heading_deg?: number | null; seq: number; hmac_tag: string; recorded_at: string }) => {
      if (!secret.current || f.seq <= lastSeq.current) return;
      const fix: Fix = { lat: f.lat, lng: f.lng, accuracyM: f.accuracy_m ?? 0, headingDeg: f.heading_deg ?? null, recordedAt: f.recorded_at };
      if (!verifyTag(secret.current, errandId, f.seq, fix, fromB64(f.hmac_tag))) return;   // discarded, never drawn
      lastSeq.current = f.seq;
      setPeer({ lat: f.lat, lng: f.lng, at: f.recorded_at, verified: true });
    };
    const off = onRealtime((event, data) => {
      if (event === 'location.fix' && data.errand_id === errandId && data.from !== role) accept(data as never);
    });
    let timer: ReturnType<typeof setInterval> | null = null;
    if (role === 'requester') {
      const poll = () => api.get<LocationView>(`/errands/${errandId}/location`).then((v) => {
        if (v.point && v.seq !== undefined && v.hmac_tag && v.recorded_at) {
          accept({ lat: v.point.lat, lng: v.point.lng, accuracy_m: v.point.accuracy_m, heading_deg: null, seq: v.seq, hmac_tag: v.hmac_tag, recorded_at: v.recorded_at });
        }
        if (v.state === 'revoked') setState('revoked');
      }).catch(() => undefined);
      poll();
      timer = setInterval(poll, 10_000);
    }
    return () => { off(); if (timer) clearInterval(timer); };
  }, [state, errandId, role]);

  return { state, peer };
}
