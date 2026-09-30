// apps/api/src/routes/errands.routes.ts
// The errand service (06-services.md §6.1): lifecycle, funding, the sealed auction, the
// runner feed, the run's checkpoints, and batches.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CreateErrand, FundErrand, PlaceBid, AwardBid, Invite, CancelErrand, FeedQuery,
  type BidsResponse, type FeedItem, type ErrandSummary,
} from '@sidequest/contracts';
import { z } from 'zod';
import { nextStatus, LIVE, type ErrandStatus } from '@sidequest/domain/errand/machine';
import { depositTotal } from '@sidequest/domain/pricing/fees';
import {
  fundEscrow, refundEscrow, chargeRequesterFee, cancelAfterAssignment,
} from '@sidequest/domain/ledger/posting';
import { cents } from '@sidequest/domain/money/money';
import { cleanProse, cleanText, cleanTill } from '@sidequest/domain/text/sanitize';
import { insertPostingGroup, enqueueOutbox, ledgerBalance, type Tx } from '@sidequest/db';
import { AppError, notFound, conflict } from '../plugins/errors.js';
import { LIMITS } from '../plugins/rate-limit.js';
import { parse, ids } from '../lib/validate.js';
import { makeOffer, onAssigned } from '../lib/assignment.js';
import {
  lockErrand, readErrand, assertRequester, assertRunner, loadDetail, summary, loadStalls, type ErrandRow,
} from '../lib/errands.js';

const EXPIRE_GRACE_MINUTES = 120;

const point = (p: { lat: number; lng: number }) => ({ lat: p.lat, lng: p.lng });

/** What the requester must hold in escrow: cap + max fee + bonus + their fee half on the max. */
function depositFor(e: Pick<ErrandRow, 'spend_cap_cents' | 'max_fee_cents' | 'bonus_cents'>, rateBps: number) {
  return depositTotal({
    agreedFeeCents: cents(e.max_fee_cents), goodsCapCents: cents(e.spend_cap_cents),
    bonusCents: cents(e.bonus_cents), rateBps,
  }).depositCents;
}

export default async function errandRoutes(app: FastifyInstance) {
  const { cfg, storage } = app.deps;

  // ─────────────────────────────────────────── create

  app.post('/errands', {
    preHandler: [app.requireEntitlement('errand.post'), app.requireRole('requester'), app.idempotent],
  }, async (req, reply) => {
    const body = parse(CreateErrand, req.body);
    if (body.kind === 'market_run' && body.stalls.length === 0) {
      throw new AppError(400, 'VALIDATION', 'A market run needs at least one stall');
    }
    const seqs = new Set(body.stalls.map((s) => s.seq));
    if (seqs.size !== body.stalls.length) throw new AppError(400, 'VALIDATION', 'Stall numbers must be unique');
    if (body.deadline_at && new Date(body.deadline_at) < new Date()) {
      throw new AppError(400, 'VALIDATION', 'The deadline has already passed');
    }

    // Every string another person will read is normalised on the way in (sanitize.ts).
    const title = cleanText('title', body.title, { max: 120 });
    const notes = body.notes ? cleanProse('notes', body.notes, 1000) : null;
    const dropLabel = cleanText('dropoff.label', body.dropoff.label, { max: 120 });
    const pickLabel = body.pickup ? cleanText('pickup.label', body.pickup.label, { max: 120 }) : null;
    const fundingMode = body.kind === 'market_run' ? 'tranche' : 'upfront';

    const id = await app.tx(req, async (tx) => {
      const d = point(body.dropoff), p = body.pickup ? point(body.pickup) : null;
      const [e] = await tx<{ id: string }[]>`
        INSERT INTO errand (requester_id, kind, status, title, notes, pickup, pickup_label, dropoff, dropoff_label,
                            spend_cap_cents, max_fee_cents, bonus_cents, deadline_at, auction_minutes,
                            assignment_mode, funding_mode, market, currency)
        VALUES (${req.actor!.id}, ${body.kind}, 'draft', ${title}, ${notes},
                ${p ? tx`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography` : null}, ${pickLabel},
                ST_SetSRID(ST_MakePoint(${d.lng}, ${d.lat}), 4326)::geography, ${dropLabel},
                ${body.spend_cap_cents}, ${body.max_fee_cents}, ${body.bonus_cents}, ${body.deadline_at ?? null},
                ${body.auction_minutes}, ${body.assignment_mode}, ${fundingMode}, 'KE', 'KES')
        RETURNING id`;
      for (const s of body.stalls) {
        const [st] = await tx<{ id: string }[]>`
          INSERT INTO stall (errand_id, seq, name, till_number, currency)
          VALUES (${e!.id}, ${s.seq}, ${cleanText('stall.name', s.name, { max: 80 })},
                  ${s.till_number ? cleanTill(s.till_number) : null}, 'KES')
          RETURNING id`;
        for (const i of s.items) {
          await tx`
            INSERT INTO line_item (stall_id, label, qty, unit)
            VALUES (${st!.id}, ${cleanText('item.label', i.label, { max: 80 })}, ${i.qty},
                    ${cleanText('item.unit', i.unit, { max: 16 })})`;
        }
      }
      return e!.id;
    });

    const detail = await app.tx(req, (tx) => loadDetail(tx, id, req.actor!.id, storage));
    return reply.code(201).send({ ...detail, deposit_cents: depositFor(detail, cfg.PLATFORM_FEE_BPS) });
  });

  // ─────────────────────────────────────────── publish and fund

  app.post('/errands/:id/publish', { preHandler: [app.requireEntitlement('errand.post')] }, async (req) => {
    const { id } = ids(req.params, 'id');
    return app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      assertRequester(e, req.actor!.id);
      const to = nextStatus(e.status, 'publish', 'requester');
      await tx`UPDATE errand SET status = ${to}, updated_at = now() WHERE id = ${id}`;
      return { id, status: to, deposit_cents: depositFor(e, cfg.PLATFORM_FEE_BPS) };
    });
  });

  /**
   * Fund the escrow. `wallet` is synchronous and opens the errand now; `mpesa_stk` pushes a
   * payment prompt to the requester's phone and the errand opens when the webhook confirms —
   * never on the client's word (04-api.md).
   */
  app.post('/errands/:id/fund', {
    preHandler: [app.requireEntitlement('wallet.topup'), app.idempotent, app.limit(LIMITS.topup), app.assertSessionIntegrity],
    config: { money: true },
  }, async (req, reply) => {
    const { id } = ids(req.params, 'id');
    const { rail } = parse(FundErrand, req.body);
    const actor = req.actor!.id;

    const result = await app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      assertRequester(e, actor);
      if (e.status !== 'awaiting_funds') {
        throw conflict('ERRAND_STATE_INVALID', e.status === 'draft' ? 'Publish the errand first' : 'This errand is already funded');
      }
      const deposit = depositFor(e, cfg.PLATFORM_FEE_BPS);

      if (rail === 'wallet') {
        // One funding at a time per account, so two errands cannot both spend the same balance.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'wallet:' + actor}))`;
        const balance = await ledgerBalance(tx, { account: 'user_wallet', ownerId: actor });
        if (balance < deposit) {
          throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Your wallet balance does not cover this errand', {
            required_cents: deposit, balance_cents: balance, shortfall_cents: deposit - balance,
          });
        }
        await openFundedErrand(tx, e, deposit);
        return { kind: 'funded' as const, deposit };
      }

      // M-Pesa moves whole shillings; round the push up and leave the cents in the wallet.
      const pushCents = Math.ceil(deposit / 100) * 100;
      const [p] = await tx<{ id: string }[]>`
        INSERT INTO payment (account_id, errand_id, rail, direction, amount_cents, idem_key, provider, currency, expires_at)
        VALUES (${actor}, ${id}, 'mpesa_stk', 'in', ${pushCents}, ${'fund:' + id + ':' + req.idempotency!.key},
                'daraja', 'KES', now() + interval '10 minutes')
        RETURNING id`;
      await enqueueOutbox(tx, 'payment.stk', { paymentId: p!.id, errandId: id, purpose: 'fund' }, { actorId: actor });
      return { kind: 'pending' as const, deposit, paymentId: p!.id, pushCents };
    });

    if (result.kind === 'funded') {
      return reply.send({ id, status: 'open', deposit_cents: result.deposit });
    }
    return reply.code(202).send({
      id, status: 'awaiting_funds', deposit_cents: result.deposit,
      payment: { id: result.paymentId, amount_cents: result.pushCents, status: 'initiated' },
    });
  });

  async function openFundedErrand(tx: Tx, e: ErrandRow, deposit: number) {
    await tx`
      INSERT INTO escrow (errand_id, funded_cents, held_cents, currency)
      VALUES (${e.id}, ${deposit}, ${deposit}, ${e.currency})`;
    await insertPostingGroup(tx, fundEscrow({ errandId: e.id, userId: e.requester_id, amountCents: cents(deposit), currency: e.currency }));
    const to = nextStatus(e.status, 'fund', 'system');
    const [row] = await tx<{ auction_closes_at: Date }[]>`
      UPDATE errand SET status = ${to}, updated_at = now(),
             auction_closes_at = now() + make_interval(mins => ${e.auction_minutes})
       WHERE id = ${e.id} RETURNING auction_closes_at`;
    await enqueueOutbox(tx, 'errand.published', { errandId: e.id });
    // Unassigned errands expire, and their escrow returns, rather than sitting open forever.
    const expiresIn = e.auction_minutes * 60 + EXPIRE_GRACE_MINUTES * 60;
    await enqueueOutbox(tx, 'errand.expire', { errandId: e.id }, { delaySeconds: expiresIn });
    return row!.auction_closes_at;
  }

  // ─────────────────────────────────────────── read

  const ListQuery = z.object({
    role: z.enum(['requester', 'runner']).optional(),
    status: z.enum(['live', 'open', 'done', 'all']).default('all'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  });

  app.get('/errands', { preHandler: app.requireAuth }, async (req) => {
    const q = parse(ListQuery, req.query);
    const actor = req.actor!.id;
    const role = q.role ?? (req.actor!.role === 'runner' ? 'runner' : 'requester');
    const statuses: readonly ErrandStatus[] | null =
      q.status === 'live' ? [...LIVE, 'offered', 'disputed']
      : q.status === 'open' ? ['draft', 'awaiting_funds', 'open', 'offered']
      : q.status === 'done' ? ['settled', 'cancelled', 'expired']
      : null;
    const rows = await app.tx(req, (tx) => tx<(ErrandRow & { stall_count: number; stalls_done: number })[]>`
      SELECT e.*,
             (SELECT count(*)::int FROM stall s WHERE s.errand_id = e.id) AS stall_count,
             (SELECT count(*)::int FROM stall s WHERE s.errand_id = e.id
                AND s.status IN ('approved','declined','skipped')) AS stalls_done
        FROM errand e
       WHERE ${role === 'requester' ? tx`e.requester_id = ${actor}` : tx`(e.runner_id = ${actor} OR e.offered_to = ${actor})`}
         ${statuses ? tx`AND e.status = ANY(${statuses as string[]}::errand_status[])` : tx``}
       ORDER BY e.created_at DESC
       LIMIT ${q.limit}`);
    return { data: rows.map((r): ErrandSummary => summary(r, actor, r.stall_count, r.stalls_done)), next_cursor: null };
  });

  app.get('/errands/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = ids(req.params, 'id');
    return app.tx(req, (tx) => loadDetail(tx, id, req.actor!.id, storage));
  });

  app.get('/errands/:id/stalls', { preHandler: app.requireAuth }, async (req) => {
    const { id } = ids(req.params, 'id');
    return { stalls: await app.tx(req, (tx) => loadStalls(tx, id, storage)) };
  });

  app.get('/errands/:id/escrow', { preHandler: app.requireAuth }, async (req) => {
    const { id } = ids(req.params, 'id');
    const [row] = await app.tx(req, (tx) => tx`SELECT funded_cents, held_cents, frozen_at, released_at FROM escrow WHERE errand_id = ${id}`);
    if (!row) throw notFound('No escrow for this errand');
    return row;
  });

  app.get('/errands/:id/evidence', { preHandler: app.requireAuth }, async (req) => {
    const { id } = ids(req.params, 'id');
    const rows = await app.tx(req, (tx) => tx<{ id: string; stall_id: string | null; kind: string; attempt: number;
                                                 rejected: boolean; taken_at: Date; object_key: string }[]>`
      SELECT id, stall_id, kind, attempt, rejected, taken_at, object_key FROM evidence
       WHERE errand_id = ${id} ORDER BY created_at`);
    return {
      items: await Promise.all(rows.map(async ({ object_key, ...r }) => ({ ...r, url: await storage.presignGet(object_key, 300) }))),
    };
  });

  app.get('/errands/:id/offers', { preHandler: app.requireAuth }, async (req) => {
    const { id } = ids(req.params, 'id');
    const items = await app.tx(req, (tx) => tx`
      SELECT id, runner_id, fee_cents, outcome, offered_at, expires_at, resolved_at
        FROM errand_offer WHERE errand_id = ${id} ORDER BY offered_at DESC`);
    return { items };
  });

  // ─────────────────────────────────────────── cancel

  app.post('/errands/:id/cancel', { preHandler: [app.requireAuth, app.idempotent] }, async (req) => {
    const { id } = ids(req.params, 'id');
    parse(CancelErrand, req.body);
    const actor = req.actor!;

    return app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      const by = e.requester_id === actor.id ? 'requester' : e.runner_id === actor.id ? 'runner' : null;
      if (!by) throw new AppError(403, 'FORBIDDEN', 'Not your errand');
      const to = nextStatus(e.status, 'cancel', by);
      const assigned = e.runner_id !== null;

      const escrowBalance = await ledgerBalance(tx, { account: 'escrow_hold', ownerId: e.requester_id, errandId: id });
      let runnerFee = 0;

      if (escrowBalance > 0) {
        // Money moves are written by the requester's transaction (pgroup_create in 0003 is
        // requester-only). A runner's cancel is completed by the worker in the same way.
        if (by === 'requester' && assigned) {
          // The frozen split, never a fresh computation from today's rate.
          const [fee] = await tx<{ requester_fee_cents: number }[]>`
            SELECT requester_fee_cents FROM errand_fee WHERE errand_id = ${id}`;
          const reqFee = fee?.requester_fee_cents ?? 0;
          runnerFee = Math.min(e.agreed_fee_cents ?? 0, cfg.CANCEL_FEE_CAP_CENTS);
          if (reqFee > 0) {
            await insertPostingGroup(tx, chargeRequesterFee({ errandId: id, requesterId: e.requester_id, feeCents: cents(reqFee), currency: e.currency }));
            await tx`UPDATE errand_fee SET requester_charged_at = now() WHERE errand_id = ${id}`;
          }
          await insertPostingGroup(tx, cancelAfterAssignment({
            errandId: id, requesterId: e.requester_id, runnerId: e.runner_id!, currency: e.currency,
            escrowBalanceCents: cents(escrowBalance - reqFee), cancellationFeeCents: cents(runnerFee),
            reimbursementCents: cents(0),
          }));
        } else if (by === 'requester') {
          await insertPostingGroup(tx, refundEscrow({ errandId: id, requesterId: e.requester_id, escrowBalanceCents: cents(escrowBalance), currency: e.currency }));
        } else {
          await enqueueOutbox(tx, 'errand.refund', { errandId: id, reason: 'runner_cancelled' });
        }
        if (by === 'requester') {
          await tx`UPDATE escrow SET held_cents = 0, released_at = now() WHERE errand_id = ${id}`;
        }
      }

      await tx`UPDATE errand SET status = ${to}, updated_at = now() WHERE id = ${id}`;
      await tx`UPDATE errand_offer SET outcome = 'withdrawn', resolved_at = now() WHERE errand_id = ${id} AND outcome = 'pending'`;
      if (assigned) {
        await enqueueOutbox(tx, 'card.void', { errandId: id });
        await enqueueOutbox(tx, 'link.revoke', { errandId: id });
        const other = by === 'requester' ? e.runner_id! : e.requester_id;
        await enqueueOutbox(tx, 'notify', { accountId: other, template: `errand.cancelled_by_${by}`, vars: { errandId: id } });
      }
      return { id, status: to, runner_fee_cents: runnerFee };
    });
  });

  // ─────────────────────────────────────────── the sealed auction

  app.get('/errands/:id/bids', { preHandler: app.requireRole('requester') }, async (req): Promise<BidsResponse> => {
    const { id } = ids(req.params, 'id');
    return app.tx(req, async (tx) => {
      const e = await readErrand(tx, id);
      assertRequester(e, req.actor!.id);
      const closes = e.auction_closes_at;
      // Sealed until close: the requester learns how many, never how much, so nobody can be
      // nudged by an early low bid (04-api.md).
      if (!closes || closes > new Date()) {
        const [c] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bid WHERE errand_id = ${id} AND status = 'sealed'`;
        return { sealed: true, count: c!.n, closes_at: (closes ?? new Date()).toISOString() };
      }
      const bids = await tx<{ id: string; runner_id: string; display_name: string | null; verification_tier: number | null;
                              fee_cents: number; eta_minutes: number; note: string | null; status: string; completed: number }[]>`
        SELECT b.id, b.runner_id, a.display_name, a.verification_tier, b.fee_cents, b.eta_minutes, b.note, b.status,
               COALESCE(r.completed, 0) AS completed
          FROM bid b
          LEFT JOIN account a ON a.id = b.runner_id
          LEFT JOIN relationship r ON r.runner_id = b.runner_id AND r.requester_id = ${req.actor!.id}
         WHERE b.errand_id = ${id} AND b.status IN ('sealed','won','lost')
         ORDER BY b.fee_cents, b.eta_minutes`;
      return {
        sealed: false,
        bids: bids.map((b) => ({
          id: b.id, fee_cents: b.fee_cents, eta_minutes: b.eta_minutes, note: b.note, status: b.status,
          runner: { id: b.runner_id, display_name: b.display_name ?? 'Runner', verification_tier: b.verification_tier ?? 0, completed_jobs: b.completed },
        })),
      };
    });
  });

  app.post('/errands/:id/bids', {
    preHandler: [app.requireEntitlement('bid.place'), app.requireRole('runner'), app.limit(LIMITS.writes)],
  }, async (req, reply) => {
    const { id } = ids(req.params, 'id');
    const body = parse(PlaceBid, req.body);
    const note = body.note ? cleanProse('note', body.note, 280) : null;
    const bid = await app.tx(req, async (tx) => {
      const [e] = await tx<ErrandRow[]>`SELECT * FROM errand WHERE id = ${id}`;
      if (!e || e.status !== 'open') throw new AppError(409, 'BID_CLOSED', 'This errand is not taking bids');
      if (e.auction_closes_at && e.auction_closes_at <= new Date()) throw new AppError(409, 'BID_CLOSED', 'Bidding has closed');
      if (e.requester_id === req.actor!.id) throw new AppError(403, 'FORBIDDEN', 'You cannot bid on your own errand');
      if (body.fee_cents > e.max_fee_cents) {
        throw new AppError(400, 'VALIDATION', 'Your fee is above the most this requester will pay', { max_fee_cents: e.max_fee_cents });
      }
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO bid (errand_id, runner_id, fee_cents, eta_minutes, note)
        VALUES (${id}, ${req.actor!.id}, ${body.fee_cents}, ${body.eta_minutes}, ${note})
        ON CONFLICT (errand_id, runner_id) DO UPDATE
          SET fee_cents = EXCLUDED.fee_cents, eta_minutes = EXCLUDED.eta_minutes, note = EXCLUDED.note,
              status = 'sealed', created_at = now()
          WHERE bid.status IN ('sealed','withdrawn')
        RETURNING id`;
      if (!b) throw new AppError(409, 'BID_CLOSED', 'Bidding has closed');
      return { id: b.id, requesterId: e.requester_id };
    });
    await app.publish(bid.requesterId, 'bid.received', { errand_id: id });
    return reply.code(201).send({ id: bid.id, status: 'sealed' });
  });

  app.delete('/errands/:id/bids/mine', { preHandler: [app.requireRole('runner')] }, async (req, reply) => {
    const { id } = ids(req.params, 'id');
    const n = await app.tx(req, (tx) => tx`
      UPDATE bid SET status = 'withdrawn'
       WHERE errand_id = ${id} AND runner_id = ${req.actor!.id} AND status = 'sealed'
         AND EXISTS (SELECT 1 FROM errand e WHERE e.id = ${id} AND e.status = 'open' AND e.auction_closes_at > now())
      RETURNING id`);
    if (n.length === 0) throw new AppError(409, 'BID_CLOSED', 'There is no open bid to withdraw');
    return reply.code(204).send();
  });

  /** Single-winner election. The conditional UPDATE is the whole concurrency control. */
  app.post('/errands/:id/award', {
    preHandler: [app.requireRole('requester'), app.idempotent],
  }, async (req) => {
    const { id } = ids(req.params, 'id');
    const { bid_id } = parse(AwardBid, req.body);
    return app.tx(req, async (tx) => {
      const [b] = await tx<{ runner_id: string; fee_cents: number; status: string }[]>`
        SELECT runner_id, fee_cents, status FROM bid WHERE id = ${bid_id} AND errand_id = ${id}`;
      if (!b || b.status !== 'sealed') throw notFound('Bid not found');
      const [runner] = await tx<{ verification_tier: number; suspended_at: Date | null }[]>`
        SELECT verification_tier, suspended_at FROM account WHERE id = ${b.runner_id}`;
      if (!runner || runner.suspended_at || runner.verification_tier < 3) {
        throw new AppError(409, 'TIER_REQUIRED', 'This runner is not yet verified to carry a card');
      }
      const won = await tx`
        UPDATE errand SET runner_id = ${b.runner_id}, status = 'awarded', awarded_bid_id = ${bid_id},
                          agreed_fee_cents = ${b.fee_cents}, assigned_at = now(), offered_to = NULL,
                          offer_expires_at = NULL, updated_at = now()
         WHERE id = ${id} AND requester_id = ${req.actor!.id} AND runner_id IS NULL
           AND status IN ('open','offered') AND auction_closes_at <= now()
        RETURNING id`;
      if (won.length === 0) {
        const e = await readErrand(tx, id);
        if (e.auction_closes_at && e.auction_closes_at > new Date()) throw new AppError(409, 'BID_CLOSED', 'Bids are sealed until the auction closes');
        throw new AppError(409, 'BID_CLOSED', 'This errand has already been awarded');
      }
      await tx`UPDATE bid SET status = CASE WHEN id = ${bid_id} THEN 'won'::bid_status ELSE 'lost'::bid_status END
                WHERE errand_id = ${id} AND status = 'sealed'`;
      await onAssigned(tx, { errandId: id, runnerId: b.runner_id, feeCents: b.fee_cents, rateBps: cfg.PLATFORM_FEE_BPS });
      return { errand_id: id, status: 'awarded', runner_id: b.runner_id, agreed_fee_cents: b.fee_cents };
    });
  });

  /** Direct invite to a past runner: an offer that skips the auction (04-api.md). */
  app.post('/errands/:id/invite', {
    preHandler: [app.requireRole('requester'), app.idempotent, app.limit(LIMITS.offer)],
  }, async (req, reply) => {
    const { id } = ids(req.params, 'id');
    const { runner_id, fee_cents } = parse(Invite, req.body);
    const offer = await app.tx(req, async (tx) => {
      const [rel] = await tx<{ completed: number; blocked: boolean }[]>`
        SELECT completed, blocked FROM relationship WHERE requester_id = ${req.actor!.id} AND runner_id = ${runner_id}`;
      if (!rel || rel.completed < 1 || rel.blocked) throw new AppError(409, 'NO_RELATIONSHIP', 'You can only invite a runner you have worked with');
      return makeOffer(tx, { errandId: id, requesterId: req.actor!.id, runnerId: runner_id, feeCents: fee_cents });
    });
    return reply.code(201).send(offer);
  });

  // ─────────────────────────────────────────── runner feed

  app.get('/feed', { preHandler: [app.requireEntitlement('bid.place')] }, async (req) => {
    const q = parse(FeedQuery, req.query);
    const rows = await app.tx(req, (tx) => tx<(FeedItem & { metres: number })[]>`
      WITH here AS (SELECT ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography AS g)
      SELECT e.id, e.kind, e.title, e.spend_cap_cents, e.max_fee_cents, e.bonus_cents, e.deadline_at,
             e.auction_closes_at,
             ST_Distance(COALESCE(e.pickup, e.dropoff), h.g) AS metres,
             (SELECT count(*)::int FROM stall s WHERE s.errand_id = e.id) AS stall_count,
             (SELECT b.fee_cents FROM bid b WHERE b.errand_id = e.id AND b.runner_id = ${req.actor!.id}
                AND b.status = 'sealed') AS my_bid_cents
        FROM errand e CROSS JOIN here h
       WHERE e.status = 'open'
         AND e.requester_id <> ${req.actor!.id}
         AND ST_DWithin(COALESCE(e.pickup, e.dropoff), h.g, ${q.radius_m})
       ORDER BY e.bonus_cents DESC, metres
       LIMIT 50`);
    return {
      data: rows.map(({ metres, ...r }) => ({
        ...r,
        deadline_at: r.deadline_at ? new Date(r.deadline_at).toISOString() : null,
        auction_closes_at: r.auction_closes_at ? new Date(r.auction_closes_at).toISOString() : null,
        distance_band: metres < 500 ? 'under_500m' : metres < 1500 ? 'under_1_5km' : metres < 3000 ? 'under_3km' : 'over_3km',
      })),
      next_cursor: null,
    };
  });

  // ─────────────────────────────────────────── the run

  const runnerStep = (event: 'start' | 'arrive' | 'ready_for_handover', checkpoint: 'en_route' | 'arrived' | null) =>
    async (req: FastifyRequest) => {
      const { id } = ids(req.params, 'id');
      return app.tx(req, async (tx) => {
        const e = await lockErrand(tx, id);
        assertRunner(e, req.actor!.id);
        if (event === 'ready_for_handover') {
          const [open] = await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM stall WHERE errand_id = ${id} AND status NOT IN ('approved','declined','skipped')`;
          if (open!.n > 0) throw new AppError(409, 'STALLS_OPEN', 'Finish every stall first');
        }
        const to = nextStatus(e.status, event, 'runner');
        await tx`UPDATE errand SET status = ${to}, updated_at = now() WHERE id = ${id}`;
        if (checkpoint) {
          await tx`INSERT INTO errand_checkpoint (errand_id, kind, reached_at) VALUES (${id}, ${checkpoint}, now())`;
          await enqueueOutbox(tx, 'eta.recompute', { errandId: id });
        }
        await enqueueOutbox(tx, 'notify', { accountId: e.requester_id, template: `errand.${to}`, vars: { errandId: id } });
        return { id, status: to };
      });
    };

  app.post('/errands/:id/start', { preHandler: app.requireRole('runner') }, runnerStep('start', 'en_route'));
  app.post('/errands/:id/arrive', { preHandler: app.requireRole('runner') }, runnerStep('arrive', 'arrived'));
  app.post('/errands/:id/ready', { preHandler: app.requireRole('runner') }, runnerStep('ready_for_handover', null));

  // ─────────────────────────────────────────── batches

  app.get('/batches/eligible', { preHandler: [app.requireEntitlement('batch.create')] }, async (req) => {
    const q = parse(z.object({ errand_id: z.string().uuid() }), req.query);
    const rows = await app.tx(req, async (tx) => {
      const [cur] = await tx<{ pickup_cell: string | null; deadline_at: Date | null }[]>`
        SELECT pickup_cell::text, deadline_at FROM errand WHERE id = ${q.errand_id} AND runner_id = ${req.actor!.id}`;
      if (!cur) throw notFound('Errand not found');
      if (!cur.pickup_cell) return [];
      // Same res-8 market catchment, and a deadline window that overlaps. Each keeps its own
      // card, approvals and escrow — batching plans a trip, it never pools money.
      return tx`
        SELECT e.id, e.title, e.kind, e.max_fee_cents, e.deadline_at
          FROM errand e
         WHERE e.status = 'open' AND e.pickup_cell::text = ${cur.pickup_cell}
           AND e.id <> ${q.errand_id}
           AND (${cur.deadline_at}::timestamptz IS NULL OR e.deadline_at IS NULL
                OR abs(extract(epoch FROM e.deadline_at - ${cur.deadline_at}::timestamptz)) <= 7200)
         LIMIT 10`;
    });
    return { data: rows };
  });

  app.post('/batches', { preHandler: [app.requireEntitlement('batch.create'), app.idempotent] }, async (req, reply) => {
    const body = parse(z.object({ errand_ids: z.array(z.string().uuid()).min(2).max(5), planned_for: z.string().datetime() }), req.body);
    const batch = await app.tx(req, async (tx) => {
      const mine = await tx<{ id: string; pickup_cell: string | null }[]>`
        SELECT id, pickup_cell::text FROM errand WHERE id = ANY(${body.errand_ids}::uuid[]) AND runner_id = ${req.actor!.id}`;
      if (mine.length !== body.errand_ids.length) throw new AppError(409, 'BATCH_INVALID', 'You can only batch errands you are running');
      if (new Set(mine.map((m) => m.pickup_cell)).size > 1) {
        throw new AppError(409, 'BATCH_REGIONS', 'These errands are in different market areas');
      }
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO errand_batch (runner_id, planned_for) VALUES (${req.actor!.id}, ${body.planned_for}) RETURNING id`;
      await tx`UPDATE errand SET batch_id = ${b!.id} WHERE id = ANY(${body.errand_ids}::uuid[]) AND runner_id = ${req.actor!.id}`;
      return b!;
    });
    return reply.code(201).send({ id: batch.id, errand_ids: body.errand_ids });
  });
}
