// apps/api/src/routes/assignment.routes.ts
// Both assignment modes, one atomic mechanism. The conditional UPDATE is the whole of the
// concurrency control — no Redis mutex, no advisory lock, no queue. Zero rows means you lost.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { errandOffer, errandFee } from '@sidequest/db/schema';
import { enqueueOutbox } from '@sidequest/db/repositories';
import { splitFee } from '@sidequest/domain/pricing/fees';
import { cents } from '@sidequest/domain/money/money';
import { AppError } from '../plugins/errors.js';
import { LIMITS } from '../plugins/rate-limit.js';
import { config } from '@sidequest/config';

const OFFER_TTL_SECONDS = 90;

const IdParam = z.object({ id: z.string().uuid() });

export default async function assignmentRoutes(app: FastifyInstance) {
  /**
   * `pick` mode. Requester offers the task to one runner picked off the map.
   * The offer is exclusive and expires; it does not assign.
   */
  app.post('/errands/:id/offer', {
    preHandler: [app.auth.requireRole('requester'), app.idempotency.required, app.limit(LIMITS.offer)],
    schema: {
      params: IdParam,
      body: z.object({
        runner_id: z.string().uuid(),
        fee_cents: z.number().int().positive(),
      }),
    },
  }, async (req, reply) => {
    const { id } = req.params as z.infer<typeof IdParam>;
    const { runner_id, fee_cents } = req.body as { runner_id: string; fee_cents: number };

    const expiresAt = new Date(Date.now() + OFFER_TTL_SECONDS * 1000);

    const offer = await app.tx(req, async (tx) => {
      const e = await app.repos.errands.lockForUpdate(tx, id);
      if (e.requesterId !== req.actor.id) throw new AppError(403, 'FORBIDDEN', 'Not your errand');
      if (e.runnerId) throw new AppError(409, 'ALREADY_ASSIGNED', 'This errand already has a runner');
      if (e.assignmentMode !== 'pick') throw new AppError(409, 'WRONG_MODE', 'This errand is open to first-accept');

      await app.repos.accounts.assertTier(tx, runner_id, 3);

      const [row] = await tx.insert(errandOffer)
        .values({ errandId: id, runnerId: runner_id, feeCents: fee_cents, expiresAt })
        .returning();

      await tx.execute(sql`
        UPDATE errand
           SET status = 'offered', offered_to = ${runner_id},
               offered_at = now(), offer_expires_at = ${expiresAt},
               agreed_fee_cents = ${fee_cents}
         WHERE id = ${id} AND runner_id IS NULL
      `);

      await enqueueOutbox(tx, 'notify', {
        accountId: runner_id, template: 'errand.offered',
        vars: { errandId: id, feeCents: fee_cents, expiresAt: expiresAt.toISOString() },
      });
      await enqueueOutbox(tx, 'offer.expire', { offerId: row!.id }, { delaySeconds: OFFER_TTL_SECONDS });

      return row!;
    });

    return reply.code(201).send({ offer_id: offer.id, expires_at: expiresAt.toISOString() });
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
    preHandler: [app.auth.requireEntitlement('errand.accept'), app.idempotency.required,
                 app.limit(LIMITS.accept)],
    schema: { params: IdParam },
  }, async (req, reply) => {
    const { id } = req.params as z.infer<typeof IdParam>;
    const runnerId = req.actor.id;

    const won = await app.tx(req, async (tx) => {
      const claimed = await tx.execute<{ id: string; agreed_fee_cents: number; funding_mode: string }>(sql`
        UPDATE errand
           SET runner_id = ${runnerId},
               status = 'awarded',
               assigned_at = now(),
               offered_to = NULL,
               offer_expires_at = NULL
         WHERE id = ${id}
           AND runner_id IS NULL
           AND status IN ('open', 'offered')
           AND (assignment_mode = 'open' OR (offered_to = ${runnerId} AND offer_expires_at > now()))
        RETURNING id, agreed_fee_cents, funding_mode
      `);

      if (claimed.length === 0) return null;
      const e = claimed[0]!;

      await tx.update(errandOffer)
        .set({ outcome: 'accepted', resolvedAt: new Date() })
        .where(sql`errand_id = ${id} AND runner_id = ${runnerId} AND outcome = 'pending'`);
      await tx.update(errandOffer)
        .set({ outcome: 'withdrawn', resolvedAt: new Date() })
        .where(sql`errand_id = ${id} AND outcome = 'pending'`);

      // Freeze the fee split now, at the agreed amount. Never recomputed from a rate later.
      const split = splitFee(cents(e.agreed_fee_cents), config().PLATFORM_FEE_BPS);
      await tx.insert(errandFee).values({
        errandId: id,
        baseCents: split.baseCents,
        rateBps: split.rateBps,
        requesterFeeCents: split.requesterFeeCents,
        runnerFeeCents: split.runnerFeeCents,
      }).onConflictDoNothing();

      await enqueueOutbox(tx, 'errand.assigned', { errandId: id, runnerId, fundingMode: e.funding_mode });
      // Upfront kinds load the whole agreed amount now, as a single tranche at seq 0.
      if (e.funding_mode === 'upfront') {
        await enqueueOutbox(tx, 'card.issue_and_load_full', { errandId: id });
      } else {
        await enqueueOutbox(tx, 'card.issue', { errandId: id });
      }

      return e;
    });

    if (!won) {
      throw new AppError(409, 'ALREADY_ASSIGNED', 'Another runner took this one');
    }
    return reply.code(200).send({ errand_id: id, status: 'awarded' });
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
    preHandler: [app.auth.requireRole('runner'), app.limit(LIMITS.writes)],
    schema: { params: IdParam },
  }, async (req, reply) => {
    const { id } = req.params as z.infer<typeof IdParam>;
    const runnerId = req.actor.id;

    await app.tx(req, async (tx) => {
      const declined = await tx.update(errandOffer)
        .set({ outcome: 'declined', resolvedAt: new Date() })
        .where(sql`errand_id = ${id} AND runner_id = ${runnerId} AND outcome = 'pending'`)
        .returning();
      if (declined.length === 0) {
        throw new AppError(404, 'NO_OFFER', 'You have no open offer on this errand');
      }

      await tx.execute(sql`
        UPDATE errand SET status = 'open', offered_to = NULL, offer_expires_at = NULL
         WHERE id = ${id} AND runner_id IS NULL AND offered_to = ${runnerId}
      `);
      // Addressed, not broadcast. `accountId: null` fanned this notification out to whatever
      // the notify worker treats as "no recipient" — for a template carrying an errand id,
      // that is a disclosure waiting to happen.
      const [e] = await tx.execute<{ requester_id: string }>(sql`
        SELECT requester_id FROM errand WHERE id = ${id}
      `);
      await enqueueOutbox(tx, 'notify', {
        accountId: e!.requester_id, template: 'offer.declined', vars: { errandId: id },
      });
    });

    return reply.code(204).send();
  });

  /**
   * Runners near a point. H3 narrows the candidate set; PostGIS decides visibility.
   *
   * §7.2 says this endpoint "requires a funded, published errand and is rate limited to
   * 30/hour" and that results are "coarsened to res-9 cells until an offer is made". None of
   * that was implemented: any tier-1 account could sweep precise distances and display names
   * across Nairobi at request speed. All three conditions are now enforced here, and the
   * precise point is read under a purpose-scoped RLS GUC (`app.discovery`) that the response
   * never echoes.
   */
  app.get('/runners/nearby', {
    preHandler: [app.auth.requireRole('requester'), app.limit(LIMITS.nearby)],
    schema: {
      querystring: z.object({
        errand_id: z.string().uuid(),          // was absent: discovery had no purpose to check
        radius_m: z.coerce.number().int().min(200).max(10_000).default(3000),
      }),
    },
  }, async (req, reply) => {
    const { errand_id, radius_m } = req.query as { errand_id: string; radius_m: number };

    // The origin is the ERRAND's pickup point, not a client-supplied lat/lng. A free-text
    // coordinate pair made this a map-scraping API with an auth token attached; taking the
    // point from a row the caller owns means every search is tied to real, funded demand.
    const rows = await app.tx(req, async (tx) => {
      const [e] = await tx.execute<{
        id: string; status: string; funded: boolean; lat: number; lng: number;
      }>(sql`
        SELECT e.id, e.status,
               (esc.funded_cents >= e.spend_cap_cents + e.max_fee_cents) AS funded,
               ST_Y(e.pickup_point::geometry) AS lat, ST_X(e.pickup_point::geometry) AS lng
          FROM errand e
          JOIN escrow esc ON esc.errand_id = e.id
         WHERE e.id = ${errand_id} AND e.requester_id = ${req.actor.id}
      `);
      if (!e) throw new AppError(404, 'NOT_FOUND', 'Errand not found');
      if (e.status !== 'open') throw new AppError(409, 'NOT_PUBLISHED', 'Publish the errand first');
      if (!e.funded) throw new AppError(409, 'NOT_FUNDED', 'Fund the escrow first');

      return tx.execute<{
        runner_id: string; display_name: string; band: string; cell_r9: string;
        completed: number; recorded_at: Date;
      }>(sql`
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
                 ON r.runner_id = rl.runner_id AND r.requester_id = ${req.actor.id}
         WHERE rl.is_online
           AND rl.cell_r8 = ANY (h3_grid_disk(o.cell, 1))
           AND a.verification_tier >= 3
           AND a.suspended_at IS NULL
           AND rl.received_at > now() - interval '2 minutes'
           AND (r.blocked IS NOT TRUE)
           AND ST_DWithin(rl.point, o.g, ${radius_m})
         ORDER BY ST_Distance(rl.point, o.g)
         LIMIT 50
      `);
    }, { discovery: true });

    // Audited: a location read is a location read, even an aggregate one. §7.4 promises this.
    app.audit(req, { action: 'runners.nearby', subject: errand_id, count: rows.length });

    return reply.send({
      errand_id,
      radius_m,
      runners: rows.map((r) => ({
        runner_id: r.runner_id,
        display_name: r.display_name,
        distance_band: r.band,        // no metres until the runner accepts and the link is live
        cell_r9: r.cell_r9,           // the map clusters on this, not on pixel distance
        completed_with_you: r.completed,
        fix_age_seconds: Math.round((Date.now() - r.recorded_at.getTime()) / 1000),
      })),
    });
  });
}
