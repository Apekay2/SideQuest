// apps/api/src/routes/assignment.routes.ts
// Both assignment modes, one atomic mechanism. The conditional UPDATE is the whole of the
// concurrency control — no Redis mutex, no advisory lock, no queue. Zero rows means you lost.

import type { FastifyInstance } from 'fastify';
import { Offer, NearbyQuery, type NearbyRunner } from '@sidequest/contracts';
import { enqueueOutbox } from '@sidequest/db';
import { depositTotal } from '@sidequest/domain/pricing/fees';
import { cents } from '@sidequest/domain/money/money';
import { AppError } from '../plugins/errors.js';
import { LIMITS } from '../plugins/rate-limit.js';
import { parse, ids } from '../lib/validate.js';
import { makeOffer, onAssigned } from '../lib/assignment.js';

export default async function assignmentRoutes(app: FastifyInstance) {
  const { cfg } = app.deps;

  /**
   * `pick` mode. Requester offers the task to one runner picked off the map.
   * The offer is exclusive and expires; it does not assign.
   */
  app.post('/errands/:id/offer', {
    preHandler: [app.requireRole('requester'), app.idempotent, app.limit(LIMITS.offer)],
  }, async (req, reply) => {
    const { id } = ids(req.params, 'id');
    const { runner_id, fee_cents } = parse(Offer, req.body);

    const offer = await app.tx(req, async (tx) => {
      // The offered runner must be tier 3 and not suspended. The requester can read that much
      // of a runner only through the discovery scope below, so the check is a scoped read of
      // exactly two columns.
      await tx`SELECT set_config('app.discovery', 'on', true)`;
      const [r] = await tx<{ verification_tier: number; suspended_at: Date | null }[]>`
        SELECT verification_tier, suspended_at FROM account WHERE id = ${runner_id}`;
      await tx`SELECT set_config('app.discovery', '', true)`;
      if (!r || r.suspended_at || r.verification_tier < 3) {
        throw new AppError(409, 'TIER_REQUIRED', 'This runner is not yet verified to carry a card');
      }
      return makeOffer(tx, { errandId: id, requesterId: req.actor!.id, runnerId: runner_id, feeCents: fee_cents });
    });

    return reply.code(201).send(offer);
  });

  /**
   * The race. Serves BOTH modes:
   *   open → any tier-3 runner may claim
   *   pick → only the invited runner may claim, and only before the offer lapses
   *
   * First write wins. The loser is told plainly and the feed refreshes; it is not an error
   * worth an apology, it is the normal outcome of two people wanting the same job.
   */
  app.post('/errands/:id/accept', {
    preHandler: [app.requireEntitlement('errand.accept'), app.requireRole('runner'), app.idempotent,
                 app.limit(LIMITS.accept)],
  }, async (req) => {
    const { id } = ids(req.params, 'id');
    const runnerId = req.actor!.id;

    const won = await app.tx(req, async (tx) => {
      // In `open` mode the fee is the requester's ceiling unless a bid set it; in `pick` mode
      // the offer already wrote agreed_fee_cents.
      const claimed = await tx<{ id: string; agreed_fee_cents: number; funding_mode: string }[]>`
        UPDATE errand
           SET runner_id = ${runnerId},
               status = 'awarded',
               assigned_at = now(),
               agreed_fee_cents = COALESCE(agreed_fee_cents, max_fee_cents),
               offered_to = NULL,
               offer_expires_at = NULL,
               updated_at = now()
         WHERE id = ${id}
           AND runner_id IS NULL
           AND requester_id <> ${runnerId}
           AND status IN ('open', 'offered')
           AND ((assignment_mode = 'open' AND status = 'open')
                OR (offered_to = ${runnerId} AND offer_expires_at > now()))
        RETURNING id, agreed_fee_cents, funding_mode`;

      if (claimed.length === 0) return null;
      const e = claimed[0]!;

      await tx`UPDATE errand_offer SET outcome = 'accepted', resolved_at = now()
                WHERE errand_id = ${id} AND runner_id = ${runnerId} AND outcome = 'pending'`;
      await tx`UPDATE errand_offer SET outcome = 'withdrawn', resolved_at = now()
                WHERE errand_id = ${id} AND outcome = 'pending'`;
      await tx`INSERT INTO errand_checkpoint (errand_id, kind, reached_at) VALUES (${id}, 'assigned', now())`;
      await onAssigned(tx, { errandId: id, runnerId, feeCents: e.agreed_fee_cents, rateBps: cfg.PLATFORM_FEE_BPS });
      return e;
    });

    if (!won) {
      throw new AppError(409, 'ALREADY_ASSIGNED', 'Another runner took this one');
    }
    return { errand_id: id, status: 'awarded', agreed_fee_cents: won.agreed_fee_cents };
  });

  /**
   * Runner declines an offer. Returns the errand to the requester immediately.
   *
   * Was exploitable: the UPDATE only required `runner_id IS NULL`, so any runner could POST
   * this for any unassigned errand and knock a rival's offer back to `open` — repeatedly,
   * for free, until they won the race themselves. The decline now has to hit a pending
   * offer addressed to THIS runner, and the errand UPDATE is scoped to `offered_to = actor`.
   */
  app.post('/errands/:id/decline-offer', {
    preHandler: [app.requireRole('runner'), app.limit(LIMITS.writes)],
  }, async (req, reply) => {
    const { id } = ids(req.params, 'id');
    const runnerId = req.actor!.id;

    await app.tx(req, async (tx) => {
      const declined = await tx`
        UPDATE errand_offer SET outcome = 'declined', resolved_at = now()
         WHERE errand_id = ${id} AND runner_id = ${runnerId} AND outcome = 'pending'
        RETURNING id`;
      if (declined.length === 0) {
        throw new AppError(404, 'NO_OFFER', 'You have no open offer on this errand');
      }

      const [e] = await tx<{ requester_id: string }[]>`
        UPDATE errand SET status = 'open', offered_to = NULL, offer_expires_at = NULL, updated_at = now()
         WHERE id = ${id} AND runner_id IS NULL AND offered_to = ${runnerId}
        RETURNING requester_id`;
      // Addressed, not broadcast. `accountId: null` fanned this notification out to whatever
      // the notify worker treats as "no recipient" — for a template carrying an errand id,
      // that is a disclosure waiting to happen. The requester id comes from the row the
      // runner just updated, which RLS let them see only because they were offered it.
      if (e) {
        await enqueueOutbox(tx, 'notify', {
          accountId: e.requester_id, template: 'offer.declined', vars: { errandId: id },
        });
      }
    });

    return reply.code(204).send();
  });

  /**
   * Runners near a point. H3 narrows the candidate set; PostGIS decides visibility.
   *
   * §7.2 says this endpoint "requires a funded, published errand and is rate limited to
   * 30/hour" and that results are "coarsened to res-9 cells until an offer is made". All
   * three conditions are enforced here, and the precise point is read under a
   * purpose-scoped RLS GUC (`app.discovery`) that the response never echoes.
   *
   * CORRECTED: the handoff version read `e.pickup_point` and `e.max_fee_cents`, neither of
   * which existed, so it could only ever 500. It also measured "funded" against cap + fee,
   * which is not the deposit the requester actually made.
   */
  app.get('/runners/nearby', {
    preHandler: [app.requireRole('requester'), app.limit(LIMITS.nearby)],
  }, async (req) => {
    const { errand_id, radius_m } = parse(NearbyQuery, req.query);

    // The origin is the ERRAND's point, not a client-supplied lat/lng. A free-text
    // coordinate pair made this a map-scraping API with an auth token attached; taking the
    // point from a row the caller owns means every search is tied to real, funded demand.
    // H3 narrows, so the candidate disk must cover the whole radius. Res-8 cell centres sit
    // ~0.92 km apart; a disk of k rings reaches about k × 0.92 km. 06-services.md §6.5 used
    // k = 1 for a 3 km search, which reaches ~1.4 km and silently dropped every runner
    // between 1.4 and 3 km. One extra ring absorbs hexagon edge effects.
    const rings = Math.ceil(radius_m / 920) + 1;

    const rows = await app.tx(req, async (tx) => {
      const [e] = await tx<{ id: string; status: string; funded_cents: number | null; spend_cap_cents: number;
                             max_fee_cents: number; bonus_cents: number; lat: number; lng: number }[]>`
        SELECT e.id, e.status, esc.funded_cents, e.spend_cap_cents, e.max_fee_cents, e.bonus_cents,
               ST_Y(COALESCE(e.pickup, e.dropoff)::geometry) AS lat,
               ST_X(COALESCE(e.pickup, e.dropoff)::geometry) AS lng
          FROM errand e
          LEFT JOIN escrow esc ON esc.errand_id = e.id
         WHERE e.id = ${errand_id} AND e.requester_id = ${req.actor!.id}`;
      if (!e) throw new AppError(404, 'NOT_FOUND', 'Errand not found');
      if (e.status !== 'open' && e.status !== 'offered') throw new AppError(409, 'NOT_PUBLISHED', 'Publish and fund the errand first');
      const need = depositTotal({
        agreedFeeCents: cents(e.max_fee_cents), goodsCapCents: cents(e.spend_cap_cents),
        bonusCents: cents(e.bonus_cents), rateBps: cfg.PLATFORM_FEE_BPS,
      }).depositCents;
      if ((e.funded_cents ?? 0) < need) throw new AppError(409, 'NOT_FUNDED', 'Fund the escrow first');

      return tx<{ runner_id: string; display_name: string; band: string; cell_r9: string;
                  completed: number; recorded_at: Date }[]>`
        WITH origin AS (
          SELECT ST_SetSRID(ST_MakePoint(${e.lng}, ${e.lat}), 4326)::geography AS g,
                 h3_lat_lng_to_cell(ST_SetSRID(ST_MakePoint(${e.lng}, ${e.lat}), 4326), 8) AS cell
        )
        SELECT rl.runner_id,
               a.display_name,
               -- Banded, not metres. A metre-accurate distance from three requests is a
               -- trilateration of someone's exact position; a band is enough to choose.
               CASE WHEN ST_Distance(rl.point, o.g) < 500  THEN 'under_500m'
                    WHEN ST_Distance(rl.point, o.g) < 1500 THEN 'under_1_5km'
                    WHEN ST_Distance(rl.point, o.g) < 3000 THEN 'under_3km'
                    ELSE 'over_3km' END AS band,
               rl.cell_r9::text AS cell_r9,
               COALESCE(r.completed, 0) AS completed,
               rl.recorded_at
          FROM runner_location rl
          JOIN account a ON a.id = rl.runner_id
          CROSS JOIN origin o
          LEFT JOIN relationship r
                 ON r.runner_id = rl.runner_id AND r.requester_id = ${req.actor!.id}
         WHERE rl.is_online
           AND rl.cell_r8 = ANY (h3_grid_disk(o.cell, ${rings}))
           AND a.verification_tier >= 3
           AND a.suspended_at IS NULL
           AND a.id <> ${req.actor!.id}
           AND rl.received_at > now() - interval '2 minutes'
           AND (r.blocked IS NOT TRUE)
           AND ST_DWithin(rl.point, o.g, ${radius_m})
         ORDER BY ST_Distance(rl.point, o.g)
         LIMIT 50`;
    }, { discovery: true });

    // Audited: a location read is a location read, even an aggregate one. §7.4 promises this.
    await app.audit(req, { action: 'runners.nearby', subject: errand_id, meta: { count: rows.length } });

    return {
      errand_id,
      radius_m,
      runners: rows.map((r): NearbyRunner => ({
        runner_id: r.runner_id,
        display_name: r.display_name,
        distance_band: r.band,        // no metres until the runner accepts and the link is live
        cell_r9: r.cell_r9,           // the map clusters on this, not on pixel distance
        completed_with_you: r.completed,
        fix_age_seconds: Math.round((Date.now() - r.recorded_at.getTime()) / 1000),
      })),
    };
  });
}
