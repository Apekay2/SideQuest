// apps/api/src/routes/stalls.routes.ts
// The money path's HTTP surface. The approval handler is the most important 60 lines
// in the codebase: it holds escrow, writes the tranche and enqueues the load in ONE
// transaction, via the outbox. Nothing here talks to the issuer directly.

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  PriceItems, EvidenceRequest, DeclineStall, Substitute, ReimbursementConfirm, type ApproveResponse,
} from '@sidequest/contracts';
import { z } from 'zod';
import { planTranche, SpendCapExceededError } from '@sidequest/domain/card/tranche';
import { nextStatus } from '@sidequest/domain/errand/machine';
import { holdForTranche } from '@sidequest/domain/ledger/posting';
import { cents } from '@sidequest/domain/money/money';
import { cleanProse, cleanText } from '@sidequest/domain/text/sanitize';
import { insertPostingGroup, enqueueOutbox, type Tx } from '@sidequest/db';
import { AppError, notFound } from '../plugins/errors.js';
import { LIMITS } from '../plugins/rate-limit.js';
import { parse, ids } from '../lib/validate.js';
import { lockErrand, assertRequester, assertRunner, loadTranches, maybeAdvanceToHandover, type ErrandRow } from '../lib/errands.js';

interface StallRow {
  id: string; errand_id: string; seq: number; name: string; till_number: string | null;
  status: 'pending' | 'photographed' | 'approved' | 'declined' | 'substituted' | 'skipped';
  total_cents: number;
}

// Every handler here takes BOTH ids, and every one of them used to trust `sid` on its own:
// `setPrices(sid)`, `update(stall).where(eq(stall.id, sid))` and the decline path all wrote
// to a stall without ever checking it belonged to the errand whose party the caller is.
// A runner on their own errand could therefore price or decline a stall on someone else's.
// One helper, used by all of them, and RLS behind it as the second wall.
async function stallOfErrand(tx: Tx, errandId: string, stallId: string): Promise<StallRow> {
  const [s] = await tx<StallRow[]>`SELECT * FROM stall WHERE id = ${stallId} FOR UPDATE`;
  if (!s || s.errand_id !== errandId) throw notFound('Stall not found');
  return s;
}

async function recomputeTotal(tx: Tx, stallId: string): Promise<number> {
  // A substituted-away original (accepted = false) no longer counts; its replacement does.
  const [r] = await tx<{ total: number }[]>`
    UPDATE stall SET total_cents = COALESCE((
      SELECT sum(price_cents) FROM line_item WHERE stall_id = ${stallId} AND accepted IS NOT FALSE), 0)
     WHERE id = ${stallId} RETURNING total_cents AS total`;
  return r!.total;
}

/** After a stall leaves `photographed`: the errand returns to shopping unless another waits. */
async function afterStallResolved(tx: Tx, e: ErrandRow, event: 'approve_stall' | 'decline_stall' | 'reject_photo') {
  const [w] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stall WHERE errand_id = ${e.id} AND status = 'photographed'`;
  if (w!.n === 0 && e.status === 'awaiting_approval') {
    await tx`UPDATE errand SET status = ${nextStatus(e.status, event, 'requester')}, updated_at = now() WHERE id = ${e.id}`;
  }
}

export default async function stallRoutes(app: FastifyInstance) {
  const { cfg, storage } = app.deps;

  /** Runner enters the prices actually found at the stall. */
  app.post('/errands/:id/stalls/:sid/items', {
    preHandler: [app.requireRole('runner'), app.limit(LIMITS.writes)],
  }, async (req) => {
    const { id, sid } = ids(req.params, 'id', 'sid');
    const { items } = parse(PriceItems, req.body);

    const total = await app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      assertRunner(e, req.actor!.id);
      const s = await stallOfErrand(tx, id, sid);
      if (s.status !== 'pending') throw new AppError(409, 'ERRAND_STATE_INVALID', 'This stall has already been submitted');
      // The item ids in the body are equally untrusted: the UPDATE is scoped to
      // `WHERE stall_id = $sid AND id = $item`, so an id from another stall matches nothing
      // instead of repricing a stranger's basket — and that is reported, not ignored.
      for (const it of items) {
        const hit = await tx`UPDATE line_item SET price_cents = ${it.price_cents}
                              WHERE stall_id = ${sid} AND id = ${it.id} RETURNING id`;
        if (hit.length === 0) throw notFound('Item not found on this stall');
      }
      return recomputeTotal(tx, sid);
    });

    return { total_cents: total };
  });

  /**
   * Runner requests an upload slot for a stall photo. One retake: the second rejected photo
   * turns into a requester decision, and a third upload is refused (RETAKE_EXHAUSTED).
   */
  app.post('/errands/:id/stalls/:sid/evidence', {
    preHandler: [app.requireRole('runner'), app.limit(LIMITS.writes)],
  }, async (req, reply) => {
    const { id, sid } = ids(req.params, 'id', 'sid');
    const body = parse(EvidenceRequest, req.body);

    const key = await app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      assertRunner(e, req.actor!.id);
      const s = await stallOfErrand(tx, id, sid);
      if (s.status !== 'pending') throw new AppError(409, 'ERRAND_STATE_INVALID', 'This stall is not open for photos');
      const [prev] = await tx<{ attempt: number; rejected: boolean }[]>`
        SELECT attempt, rejected FROM evidence WHERE stall_id = ${sid} AND kind = ${body.kind}
         ORDER BY created_at DESC LIMIT 1`;
      // A photo that was not rejected is simply replaced within the same attempt; a rejected
      // one moves to the next attempt.
      const attempt = !prev ? 1 : prev.rejected ? prev.attempt + 1 : prev.attempt;
      if (attempt > cfg.MAX_EVIDENCE_ATTEMPTS) {
        throw new AppError(409, 'RETAKE_EXHAUSTED', 'The requester will decide on this stall', { attempts: prev?.attempt ?? 0 });
      }
      const ext = body.content_type === 'image/png' ? 'png' : 'jpg';
      const k = `evidence/${id}/${sid}/${body.kind}-${attempt}-${randomUUID()}.${ext}`;
      await tx`
        INSERT INTO evidence (errand_id, stall_id, kind, object_key, taken_at, taken_at_geo, attempt)
        VALUES (${id}, ${sid}, ${body.kind}, ${k}, ${body.taken_at},
                ${body.lat !== undefined && body.lng !== undefined
                  ? tx`ST_SetSRID(ST_MakePoint(${body.lng}, ${body.lat}), 4326)::geography` : null},
                ${attempt})`;
      return { key: k, attempt };
    });

    const put = await storage.presignPut(key.key, body.content_type, cfg.PRESIGN_TTL_SECONDS);
    return reply.code(201).send({ upload_url: put.url, object_key: key.key, headers: put.headers, expires_in: put.expiresIn, attempt: key.attempt });
  });

  /** Runner submits the stall for approval. */
  app.post('/errands/:id/stalls/:sid/submit', { preHandler: app.requireRole('runner') }, async (req, reply) => {
    const { id, sid } = ids(req.params, 'id', 'sid');

    const requesterId = await app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      assertRunner(e, req.actor!.id);
      const s = await stallOfErrand(tx, id, sid);
      if (s.status !== 'pending') throw new AppError(409, 'ERRAND_STATE_INVALID', 'This stall has already been submitted');
      const [ev] = await tx`SELECT 1 FROM evidence WHERE stall_id = ${sid} AND kind = 'goods' AND NOT rejected LIMIT 1`;
      if (!ev) throw new AppError(409, 'EVIDENCE_REQUIRED', 'Photograph the items first');
      const [unpriced] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM line_item WHERE stall_id = ${sid} AND accepted IS NOT FALSE AND price_cents IS NULL`;
      if (unpriced!.n > 0) throw new AppError(409, 'ITEMS_UNPRICED', 'Enter a price for every item');
      const total = await recomputeTotal(tx, sid);
      if (total <= 0) throw new AppError(409, 'ITEMS_UNPRICED', 'This stall has no priced items');

      const to = nextStatus(e.status, 'submit_stall', 'runner');
      await tx`UPDATE stall SET status = 'photographed' WHERE id = ${sid} AND errand_id = ${id}`;
      await tx`UPDATE errand SET status = ${to}, updated_at = now() WHERE id = ${id}`;
      await tx`INSERT INTO errand_checkpoint (errand_id, kind, stall_id, reached_at) VALUES (${id}, 'stall_submitted', ${sid}, now())
               ON CONFLICT (errand_id, kind, stall_id) DO NOTHING`;
      await enqueueOutbox(tx, 'eta.recompute', { errandId: id });
      await enqueueOutbox(tx, 'notify', {
        accountId: e.requester_id, template: 'stall.submitted', vars: { errandId: id, stallId: sid },
      });
      return e.requester_id;
    });

    await app.publish(requesterId, 'stall.submitted', { errand_id: id, stall_id: sid });
    return reply.code(204).send();
  });

  /**
   * Requester approves a stall. Returns 202 — the card load is durable work, not a
   * request-scoped side effect. The client polls /tranches or waits on `tranche.loaded`.
   */
  app.post('/errands/:id/stalls/:sid/approve', {
    // Approval is the money path: it is idempotency-keyed, velocity-limited per errand, and
    // re-checks the session row so a revoked session stops moving money immediately.
    preHandler: [app.requireRole('requester'), app.idempotent, app.limit(LIMITS.approval), app.assertSessionIntegrity],
    config: { money: true },
  }, async (req, reply): Promise<ApproveResponse> => {
    const { id, sid } = ids(req.params, 'id', 'sid');

    // SERIALIZABLE: two stalls approved at the same instant must not both fit under the cap.
    const result = await app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      assertRequester(e, req.actor!.id);
      const s = await stallOfErrand(tx, id, sid);

      let plan;
      try {
        plan = planTranche(
          { errandId: id, spendCapCents: cents(e.spend_cap_cents), spentCents: cents(e.spent_cents) },
          { stallId: s.id, seq: s.seq, totalCents: cents(s.total_cents), tillNumber: s.till_number, status: s.status },
        );
      } catch (err) {
        if (err instanceof SpendCapExceededError) {
          throw new AppError(409, err.code, 'This stall is over what is left of your spending cap', {
            requested_cents: err.requested, remaining_cents: err.remaining, over_by_cents: err.requested - err.remaining,
          });
        }
        throw new AppError(409, 'ERRAND_STATE_INVALID', (err as Error).message);
      }

      const [c] = await tx<{ id: string; voided_at: Date | null }[]>`SELECT id, voided_at FROM card WHERE errand_id = ${id}`;
      if (!c) throw new AppError(409, 'CARD_MISSING', 'The card is still being issued. Try again in a moment.');
      if (c.voided_at) throw new AppError(409, 'CARD_VOIDED', 'Card is closed');

      // 1. Ledger: escrow → this errand's card float.
      await insertPostingGroup(tx, holdForTranche({
        errandId: id, requesterId: e.requester_id, amountCents: cents(plan.amountCents), currency: e.currency,
      }));

      // 2. Escrow bookkeeping mirror, for cheap reads. The CHECK (held_cents >= 0) is a
      // second wall behind the cap check above.
      await tx`UPDATE escrow SET held_cents = held_cents - ${plan.amountCents} WHERE errand_id = ${id}`;

      // 3. The tranche itself.
      const [row] = await tx<{ id: string; seq: number; amount_cents: number }[]>`
        INSERT INTO tranche (card_id, stall_id, seq, amount_cents, idem_key, status, currency)
        VALUES (${c.id}, ${plan.stallId}, ${plan.seq}, ${plan.amountCents}, ${plan.idemKey}, 'pending', ${e.currency})
        RETURNING id, seq, amount_cents`;

      // 4. Stall and errand state.
      await tx`UPDATE stall SET status = 'approved', approved_at = now() WHERE id = ${sid} AND status = 'photographed'`;
      await tx`UPDATE errand SET spent_cents = spent_cents + ${plan.amountCents}, updated_at = now() WHERE id = ${id}`;
      await afterStallResolved(tx, e, 'approve_stall');

      // 5. Outbox — committed with everything above. Redis being down cannot lose this.
      await enqueueOutbox(tx, 'card.load', { trancheId: row!.id, errandId: id });
      await enqueueOutbox(tx, 'checkpoint.record', { errandId: id, kind: 'stall_approved', stallId: sid });

      return { tranche: row!, remaining: plan.remainingAfterCents, runnerId: e.runner_id };
    }, { isolation: 'serializable' });

    if (result.runnerId) await app.publish(result.runnerId, 'stall.approved', { errand_id: id, stall_id: sid });
    reply.code(202);
    return {
      tranche: { id: result.tranche.id, seq: result.tranche.seq, amount_cents: result.tranche.amount_cents, status: 'pending' },
      remaining_cap_cents: result.remaining,
      poll_after_ms: 1500,
    };
  });

  /** Requester declines a stall outright. No tranche, no money moves. */
  app.post('/errands/:id/stalls/:sid/decline', {
    preHandler: [app.requireRole('requester'), app.limit(LIMITS.writes)],
  }, async (req, reply) => {
    const { id, sid } = ids(req.params, 'id', 'sid');
    // The reason is rendered to the runner in-app and in an SMS template. Normalised at the
    // boundary rather than trusted to every future render site.
    const reason = cleanProse('reason', parse(DeclineStall, req.body).reason, 280);

    const runnerId = await app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      assertRequester(e, req.actor!.id);
      const s = await stallOfErrand(tx, id, sid);
      if (s.status !== 'pending' && s.status !== 'photographed') {
        throw new AppError(409, 'ERRAND_STATE_INVALID', 'This stall has already been resolved');
      }
      await tx`UPDATE stall SET status = 'declined' WHERE id = ${sid} AND errand_id = ${id}`;
      await afterStallResolved(tx, e, 'decline_stall');
      if (e.runner_id) {
        await enqueueOutbox(tx, 'notify', {
          accountId: e.runner_id, template: 'stall.declined', vars: { errandId: id, stallId: sid, reason },
        });
      }
      await maybeAdvanceToHandover(tx, id);
      return e.runner_id;
    });

    if (runnerId) await app.publish(runnerId, 'stall.declined', { errand_id: id, stall_id: sid });
    return reply.code(204).send();
  });

  /** Requester sends the photo back for one retake. The second rejection is a decision. */
  app.post('/errands/:id/stalls/:sid/retake', {
    preHandler: [app.requireRole('requester'), app.limit(LIMITS.writes)],
  }, async (req, reply) => {
    const { id, sid } = ids(req.params, 'id', 'sid');
    const { reason } = parse(z.object({ reason: z.string().min(1).max(280) }), req.body);
    const clean = cleanProse('reason', reason, 280);

    const runnerId = await app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      assertRequester(e, req.actor!.id);
      const s = await stallOfErrand(tx, id, sid);
      if (s.status !== 'photographed') throw new AppError(409, 'ERRAND_STATE_INVALID', 'There is no photo waiting on this stall');
      const [ev] = await tx<{ id: string; attempt: number }[]>`
        SELECT id, attempt FROM evidence WHERE stall_id = ${sid} AND kind = 'goods' AND NOT rejected
         ORDER BY created_at DESC LIMIT 1`;
      if (ev && ev.attempt >= cfg.MAX_EVIDENCE_ATTEMPTS) {
        throw new AppError(409, 'RETAKE_EXHAUSTED', 'The runner has already retaken this photo. Approve, substitute or decline.');
      }
      // The ONLY update the app role may make to evidence is none at all (0003 grants SELECT,
      // INSERT); the rejection is recorded by the worker so evidence stays append-only here.
      await enqueueOutbox(tx, 'evidence.reject', { evidenceId: ev?.id ?? null, errandId: id, stallId: sid });
      await tx`UPDATE stall SET status = 'pending' WHERE id = ${sid}`;
      await afterStallResolved(tx, e, 'reject_photo');
      if (e.runner_id) {
        await enqueueOutbox(tx, 'notify', { accountId: e.runner_id, template: 'stall.retake', vars: { errandId: id, stallId: sid, reason: clean } });
      }
      return e.runner_id;
    });
    if (runnerId) await app.publish(runnerId, 'stall.retake', { errand_id: id, stall_id: sid });
    return reply.code(204).send();
  });

  /** Requester replaces an item with a substitute at a stated price. */
  app.post('/errands/:id/stalls/:sid/substitute', {
    preHandler: [app.requireRole('requester'), app.limit(LIMITS.writes)],
  }, async (req, reply) => {
    const { id, sid } = ids(req.params, 'id', 'sid');
    const body = parse(Substitute, req.body);

    const total = await app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      assertRequester(e, req.actor!.id);
      const s = await stallOfErrand(tx, id, sid);
      if (s.status !== 'photographed' && s.status !== 'pending') {
        throw new AppError(409, 'ERRAND_STATE_INVALID', 'This stall has already been resolved');
      }
      const hit = await tx`UPDATE line_item SET accepted = false WHERE id = ${body.line_item_id} AND stall_id = ${sid} RETURNING id`;
      if (hit.length === 0) throw notFound('Item not found on this stall');
      await tx`
        INSERT INTO line_item (stall_id, label, qty, unit, price_cents, substituted_for, accepted)
        VALUES (${sid}, ${cleanText('label', body.label, { max: 80 })}, ${body.qty},
                ${cleanText('unit', body.unit, { max: 16 })}, ${body.price_cents}, ${body.line_item_id}, true)`;
      return recomputeTotal(tx, sid);
    });
    return reply.code(201).send({ total_cents: total });
  });

  /** Tranche + attempt trace. This is what the runner's "spend now" card polls. */
  app.get('/errands/:id/tranches', { preHandler: app.requireAuth }, async (req) => {
    const { id } = ids(req.params, 'id');
    return { items: await app.tx(req, (tx) => loadTranches(tx, id)) };
  });

  app.get('/errands/:id/tranches/:tid', { preHandler: app.requireAuth }, async (req) => {
    const { id, tid } = ids(req.params, 'id', 'tid');
    const t = (await app.tx(req, (tx) => loadTranches(tx, id))).find((x) => x.id === tid);
    if (!t) throw notFound('Tranche not found');
    return t;
  });

  /** Ladder rung 3: the requester agrees (or refuses) to reimburse a cash payment. */
  app.post('/errands/:id/reimbursement/confirm', {
    preHandler: [app.requireRole('requester'), app.idempotent, app.assertSessionIntegrity],
    config: { money: true },
  }, async (req) => {
    const { id } = ids(req.params, 'id');
    const { tranche_id, accept } = parse(ReimbursementConfirm, req.body);
    await app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      assertRequester(e, req.actor!.id);
      const [t] = await tx<{ id: string; status: string }[]>`
        SELECT t.id, t.status FROM tranche t JOIN card c ON c.id = t.card_id
         WHERE t.id = ${tranche_id} AND c.errand_id = ${id} FOR UPDATE OF t`;
      if (!t) throw notFound('Tranche not found');
      const [pending] = await tx`
        SELECT 1 FROM card_attempt WHERE tranche_id = ${tranche_id} AND rung = 'reimbursement' AND result = 'pending'`;
      if (t.status !== 'pending' || !pending) throw new AppError(409, 'ERRAND_STATE_INVALID', 'There is no reimbursement waiting on you');
      await tx`UPDATE tranche SET reimbursement_confirmed = ${accept} WHERE id = ${tranche_id} AND reimbursement_confirmed IS NULL`;
      await enqueueOutbox(tx, 'card.load', { trancheId: tranche_id, errandId: id, wake: 'reimbursement_answer' });
    });
    return { tranche_id, accepted: accept };
  });
}
