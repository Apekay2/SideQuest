// apps/api/src/routes/location.routes.ts
// The location service (06-services.md §6.5, §6.8) and the link handshake (01-architecture
// §1.9). The server holds the two X25519 public keys and the derived hash — never the shared
// secret — and stores each fix's HMAC tag for the RECEIVING device to verify. The platform
// still reads the point it needs for matching: this is authenticity and scoping, not
// confidentiality from the platform, and the doc says so.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LinkPublish, LinkAck, LocationBatch, type LinkState, type LocationView } from '@sidequest/contracts';
import { linkState, presence } from '@sidequest/domain/errand/link-handshake';
import type { Tx } from '@sidequest/db';
import { AppError, notFound } from '../plugins/errors.js';
import { LIMITS } from '../plugins/rate-limit.js';
import { parse, ids } from '../lib/validate.js';
import { readErrand, type ErrandRow } from '../lib/errands.js';

const LIVE_FOR_LINK = ['awarded', 'en_route', 'shopping', 'awaiting_approval', 'handover'];

interface LinkRow {
  errand_id: string; requester_pub: Buffer | null; runner_pub: Buffer | null; link_hash: Buffer | null;
  requester_ack_at: Date | null; runner_ack_at: Date | null; revoked_at: Date | null;
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sideOf(e: ErrandRow, actorId: string): 'requester' | 'runner' {
  if (e.requester_id === actorId) return 'requester';
  if (e.runner_id === actorId) return 'runner';
  throw new AppError(404, 'NOT_FOUND', 'Errand not found');
}

function stateOf(l: LinkRow | undefined) {
  return linkState({
    requesterPub: l?.requester_pub ?? null, runnerPub: l?.runner_pub ?? null,
    requesterAckAt: l?.requester_ack_at ?? null, runnerAckAt: l?.runner_ack_at ?? null,
    revokedAt: l?.revoked_at ?? null,
  });
}

function view(l: LinkRow | undefined, side: 'requester' | 'runner'): LinkState {
  const counterpart = side === 'requester' ? l?.runner_pub : l?.requester_pub;
  return { state: stateOf(l), counterpart_key: counterpart ? counterpart.toString('base64') : null };
}

async function hasMovementConsent(tx: Tx, runnerId: string): Promise<boolean> {
  const [k] = await tx`SELECT 1 FROM kyc_case WHERE account_id = ${runnerId} AND status = 'approved'
                        AND target_tier = 3 AND movement_consent LIMIT 1`;
  return Boolean(k);
}

export default async function locationRoutes(app: FastifyInstance) {
  const { redis } = app.deps;

  // ─────────────────────────────────────────── handshake

  app.get('/errands/:id/link', { preHandler: app.requireAuth }, async (req) => {
    const { id } = ids(req.params, 'id');
    return app.tx(req, async (tx) => {
      const e = await readErrand(tx, id);
      const [l] = await tx<LinkRow[]>`SELECT * FROM errand_link WHERE errand_id = ${id}`;
      return view(l, sideOf(e, req.actor!.id));
    });
  });

  /** Publish this device's X25519 public key; returns the counterpart's once available. */
  app.post('/errands/:id/link', { preHandler: [app.requireAuth, app.limit(LIMITS.writes)] }, async (req) => {
    const { id } = ids(req.params, 'id');
    const key = b64(parse(LinkPublish, req.body).public_key);
    if (key.length !== 32) throw new AppError(400, 'VALIDATION', 'Public key must be 32 bytes');

    return app.tx(req, async (tx) => {
      const e = await readErrand(tx, id);
      const side = sideOf(e, req.actor!.id);
      if (!e.runner_id || !LIVE_FOR_LINK.includes(e.status)) {
        throw new AppError(409, 'ERRAND_STATE_INVALID', 'Location sharing starts once a runner is assigned');
      }
      const col = side === 'requester' ? 'requester_pub' : 'runner_pub';
      const [cur] = await tx<LinkRow[]>`SELECT * FROM errand_link WHERE errand_id = ${id} FOR UPDATE`;
      if (cur?.revoked_at) throw new AppError(409, 'LINK_REVOKED', 'Location sharing has ended for this errand');
      // A key, once published, is fixed for the errand. Replacing it would silently break the
      // other device's derived secret.
      if (cur?.[col] && !cur[col]!.equals(key)) throw new AppError(409, 'LINK_KEY_SET', 'A key is already registered for this device');

      await tx`
        INSERT INTO errand_link (errand_id, ${tx(col)}) VALUES (${id}, ${key})
        ON CONFLICT (errand_id) DO UPDATE SET ${tx(col)} = EXCLUDED.${tx(col)}`;
      const [l] = await tx<LinkRow[]>`SELECT * FROM errand_link WHERE errand_id = ${id}`;
      // Both keys present: the server derives the hash the two devices must independently
      // arrive at. Key order is fixed (requester, then runner) — see linkHash().
      if (l!.requester_pub && l!.runner_pub && !l!.link_hash) {
        const h = createHash('sha256').update(l!.requester_pub).update(l!.runner_pub).update(id, 'utf8').digest();
        await tx`UPDATE errand_link SET link_hash = ${h} WHERE errand_id = ${id}`;
        l!.link_hash = h;
      }
      const other = side === 'requester' ? e.runner_id : e.requester_id;
      if (other) await app.publish(other, 'link.key_published', { errand_id: id });
      return view(l, side);
    });
  });

  /** The handshake proof: sharing stays refused until both sides post the same hash. */
  app.post('/errands/:id/link/ack', { preHandler: [app.requireAuth, app.limit(LIMITS.writes)] }, async (req) => {
    const { id } = ids(req.params, 'id');
    const presented = b64(parse(LinkAck, req.body).link_hash);
    return app.tx(req, async (tx) => {
      const e = await readErrand(tx, id);
      const side = sideOf(e, req.actor!.id);
      const [l] = await tx<LinkRow[]>`SELECT * FROM errand_link WHERE errand_id = ${id} FOR UPDATE`;
      if (!l?.link_hash) throw new AppError(409, 'LINK_NOT_ESTABLISHED', 'Waiting for the other phone');
      if (l.revoked_at) throw new AppError(409, 'LINK_REVOKED', 'Location sharing has ended for this errand');
      if (presented.length !== 32 || !presented.equals(l.link_hash)) {
        // A mismatch means the two devices do not hold the keys the server recorded.
        throw new AppError(409, 'LINK_MISMATCH', 'The phones did not agree. Reopen the errand on both to retry.');
      }
      await tx`UPDATE errand_link SET ${tx(side === 'requester' ? 'requester_ack_at' : 'runner_ack_at')} = now()
                WHERE errand_id = ${id}`;
      const [after] = await tx<LinkRow[]>`SELECT * FROM errand_link WHERE errand_id = ${id}`;
      const v = view(after, side);
      if (v.state === 'active') {
        await app.publish(e.requester_id, 'link.active', { errand_id: id });
        await app.publish(e.runner_id!, 'link.active', { errand_id: id });
      }
      return v;
    });
  });

  app.delete('/errands/:id/link', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = ids(req.params, 'id');
    await app.tx(req, async (tx) => {
      const e = await readErrand(tx, id);
      sideOf(e, req.actor!.id);
      await tx`
        INSERT INTO errand_link (errand_id, revoked_at) VALUES (${id}, now())
        ON CONFLICT (errand_id) DO UPDATE SET revoked_at = COALESCE(errand_link.revoked_at, now())`;
      for (const who of [e.requester_id, e.runner_id]) if (who) await app.publish(who, 'link.revoked', { errand_id: id });
    });
    await redis.del(`loc:cur:${id}`);
    return reply.code(204).send();
  });

  // ─────────────────────────────────────────── ingest

  /**
   * Runner fixes, a batch of up to four in `seq` order (queued fixes from a dead zone upload
   * this way and all still verify on the peer). Requires tier 3, movement consent, and an
   * active link — 403 CONSENT_REQUIRED or 409 LINK_NOT_ESTABLISHED otherwise.
   */
  app.post('/location', {
    preHandler: [app.requireEntitlement('errand.accept'), app.requireRole('runner'), app.limit(LIMITS.locationIngest)],
  }, async (req, reply) => {
    const { fixes } = parse(LocationBatch, req.body);
    const errandId = fixes[0]!.errand_id;
    if (fixes.some((f) => f.errand_id !== errandId)) throw new AppError(400, 'VALIDATION', 'One errand per batch');
    for (let i = 1; i < fixes.length; i++) {
      if (fixes[i]!.seq <= fixes[i - 1]!.seq) throw new AppError(400, 'VALIDATION', 'Fixes must be in increasing seq order');
    }
    const runnerId = req.actor!.id;

    const accepted = await app.tx(req, async (tx) => {
      if (!(await hasMovementConsent(tx, runnerId))) {
        throw new AppError(403, 'CONSENT_REQUIRED', 'Location sharing needs your movement consent (tier 3)');
      }
      const e = await readErrand(tx, errandId);
      if (e.runner_id !== runnerId) throw notFound('Errand not found');
      const [l] = await tx<LinkRow[]>`SELECT * FROM errand_link WHERE errand_id = ${errandId}`;
      if (stateOf(l) !== 'active') throw new AppError(409, 'LINK_NOT_ESTABLISHED', 'The link with the requester is not active');

      const [cur] = await tx<{ seq: number; errand_id: string | null }[]>`
        SELECT seq, errand_id FROM runner_location WHERE runner_id = ${runnerId}`;
      const last = cur && cur.errand_id === errandId ? cur.seq : -1;
      // Monotonic seq blocks a stale re-send; anything at or below the last accepted is dropped.
      const fresh = fixes.filter((f) => f.seq > last);
      if (fresh.length === 0) return [];

      for (const f of fresh) {
        await tx`
          INSERT INTO runner_location_history (runner_id, errand_id, point, cell_r9, recorded_at)
          VALUES (${runnerId}, ${errandId}, ST_SetSRID(ST_MakePoint(${f.lng}, ${f.lat}), 4326)::geography,
                  h3_lat_lng_to_cell(ST_SetSRID(ST_MakePoint(${f.lng}, ${f.lat}), 4326), 9), ${f.recorded_at})`;
      }
      const top = fresh[fresh.length - 1]!;
      await tx`
        INSERT INTO runner_location (runner_id, errand_id, point, cell_r9, cell_r8, accuracy_m, heading_deg,
                                     is_online, seq, hmac_tag, recorded_at, received_at)
        VALUES (${runnerId}, ${errandId}, ST_SetSRID(ST_MakePoint(${top.lng}, ${top.lat}), 4326)::geography,
                h3_lat_lng_to_cell(ST_SetSRID(ST_MakePoint(${top.lng}, ${top.lat}), 4326), 9),
                h3_lat_lng_to_cell(ST_SetSRID(ST_MakePoint(${top.lng}, ${top.lat}), 4326), 8),
                ${top.accuracy_m}, ${top.heading_deg}, true, ${top.seq}, ${b64(top.hmac_tag)}, ${top.recorded_at}, now())
        ON CONFLICT (runner_id) DO UPDATE SET
          errand_id = EXCLUDED.errand_id, point = EXCLUDED.point, accuracy_m = EXCLUDED.accuracy_m,
          heading_deg = EXCLUDED.heading_deg, is_online = true, seq = EXCLUDED.seq, hmac_tag = EXCLUDED.hmac_tag,
          recorded_at = EXCLUDED.recorded_at, received_at = now()`;
      return fresh.map((f) => ({ ...f, requesterId: e.requester_id }));
    });

    if (accepted.length) {
      // Hot tier: the latest fix, and fan-out to the requester's socket with its tag, so the
      // receiving device verifies before drawing anything (verifyFix in link-handshake.ts).
      const top = accepted[accepted.length - 1]!;
      await redis.set(`loc:cur:${errandId}`, JSON.stringify(top), 'EX', 120);
      for (const f of accepted) {
        const { requesterId, ...fix } = f;
        await app.publish(requesterId, 'location.fix', { from: 'runner', ...fix });
      }
    }
    return reply.code(202).send({ accepted: accepted.length, dropped: fixes.length - accepted.length });
  });

  /**
   * Requester → runner. Both devices stream once the link is active (06 §6.8). The requester's
   * position is ephemeral by design: it goes to the runner's socket and a 2-minute Redis key,
   * never to a table.
   */
  app.post('/errands/:id/location/requester', {
    preHandler: [app.requireRole('requester'), app.limit(LIMITS.locationIngest)],
  }, async (req, reply) => {
    const { id } = ids(req.params, 'id');
    const { fixes } = parse(LocationBatch, req.body);
    const runnerId = await app.tx(req, async (tx) => {
      const e = await readErrand(tx, id);
      if (e.requester_id !== req.actor!.id || !e.runner_id) throw notFound('Errand not found');
      const [l] = await tx<LinkRow[]>`SELECT * FROM errand_link WHERE errand_id = ${id}`;
      if (stateOf(l) !== 'active') throw new AppError(409, 'LINK_NOT_ESTABLISHED', 'The link with the runner is not active');
      return e.runner_id;
    });
    const top = fixes[fixes.length - 1]!;
    await redis.set(`loc:req:${id}`, JSON.stringify(top), 'EX', 120);
    for (const f of fixes) await app.publish(runnerId, 'location.fix', { from: 'requester', ...f });
    return reply.code(202).send({ accepted: fixes.length });
  });

  /**
   * Idle presence for discovery: every 60 s while available (06 §6.5). No errand, no link;
   * only tier-3 runners with movement consent appear on a requester's map at all.
   */
  app.post('/presence', {
    preHandler: [app.requireEntitlement('errand.accept'), app.requireRole('runner'), app.limit(LIMITS.locationIngest)],
  }, async (req, reply) => {
    const p = parse(z.object({
      lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
      accuracy_m: z.number().min(0).max(10_000).default(50), available: z.boolean(),
    }), req.body);
    await app.tx(req, async (tx) => {
      if (!(await hasMovementConsent(tx, req.actor!.id))) throw new AppError(403, 'CONSENT_REQUIRED', 'Location sharing needs your movement consent');
      // On an errand the errand stream is authoritative; presence must not overwrite it.
      const [cur] = await tx<{ errand_id: string | null }[]>`SELECT errand_id FROM runner_location WHERE runner_id = ${req.actor!.id}`;
      if (cur?.errand_id) {
        const [e] = await tx<{ status: string }[]>`SELECT status::text FROM errand WHERE id = ${cur.errand_id}`;
        if (e && LIVE_FOR_LINK.includes(e.status)) return;
      }
      await tx`
        INSERT INTO runner_location (runner_id, errand_id, point, cell_r9, cell_r8, accuracy_m, is_online, seq, hmac_tag, recorded_at)
        VALUES (${req.actor!.id}, NULL, ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography,
                h3_lat_lng_to_cell(ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326), 9),
                h3_lat_lng_to_cell(ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326), 8),
                ${p.accuracy_m}, ${p.available}, 0, '\\x'::bytea, now())
        ON CONFLICT (runner_id) DO UPDATE SET errand_id = NULL, point = EXCLUDED.point, accuracy_m = EXCLUDED.accuracy_m,
          is_online = EXCLUDED.is_online, seq = 0, hmac_tag = EXCLUDED.hmac_tag, recorded_at = now(), received_at = now()`;
    });
    return reply.code(204).send();
  });

  // ─────────────────────────────────────────── read

  /** Last verified fix, its age, and the link state — `linked_stale`, never `unknown`. */
  app.get('/errands/:id/location', { preHandler: app.requireRole('requester') }, async (req: FastifyRequest): Promise<LocationView> => {
    const { id } = ids(req.params, 'id');
    const out = await app.tx(req, async (tx) => {
      const e = await readErrand(tx, id);
      if (e.requester_id !== req.actor!.id) throw notFound('Errand not found');
      const [l] = await tx<LinkRow[]>`SELECT * FROM errand_link WHERE errand_id = ${id}`;
      const st = stateOf(l);
      if (st === 'revoked') return { state: 'revoked' as const };
      if (st !== 'active') return { state: 'pending' as const };
      // RLS (loc_linked_requester) returns this row only for the requester's own errand with a
      // live link — enforced by the database as well as by the checks above.
      const [f] = await tx<{ lat: number; lng: number; accuracy_m: number | null; seq: number; hmac_tag: Buffer; recorded_at: Date }[]>`
        SELECT ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng, accuracy_m, seq, hmac_tag, recorded_at
          FROM runner_location WHERE errand_id = ${id}`;
      if (!f) return { state: 'linked_stale' as const };
      const age = Math.round((Date.now() - f.recorded_at.getTime()) / 1000);
      return {
        state: presence('active', f.recorded_at.getTime()),
        point: { lat: f.lat, lng: f.lng, accuracy_m: f.accuracy_m },
        seq: f.seq, hmac_tag: f.hmac_tag.toString('base64'), recorded_at: f.recorded_at.toISOString(), age_seconds: age,
      };
    });
    if (out.point) await app.audit(req, { action: 'location.read', subject: id });
    return out;
  });
}
