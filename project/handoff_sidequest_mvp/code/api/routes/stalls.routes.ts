// apps/api/src/routes/stalls.routes.ts
// The money path's HTTP surface. The approval handler is the most important 60 lines
// in the codebase: it holds escrow, writes the tranche and enqueues the load in ONE
// transaction, via the outbox. Nothing here talks to the issuer directly.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { errand, stall, card, tranche, escrow } from '@sidequest/db/schema';
import { insertPostingGroup, enqueueOutbox } from '@sidequest/db/repositories';
import { planTranche, SpendCapExceededError } from '@sidequest/domain/card/tranche';
import { nextStatus } from '@sidequest/domain/errand/machine';
import { holdForTranche } from '@sidequest/domain/ledger/posting';
import { cents } from '@sidequest/domain/money/money';
import { cleanProse } from '@sidequest/domain/text/sanitize';
import { AppError } from '../plugins/errors.js';
import { LIMITS } from '../plugins/rate-limit.js';

const ApproveParams = z.object({ id: z.string().uuid(), sid: z.string().uuid() });

// Every handler here takes BOTH ids, and every one of them used to trust `sid` on its own:
// `setPrices(sid)`, `update(stall).where(eq(stall.id, sid))` and the decline path all wrote
// to a stall without ever checking it belonged to the errand whose party the caller is.
// A runner on their own errand could therefore price or decline a stall on someone else's.
// One helper, used by all of them, and RLS behind it as the second wall.
async function stallOfErrand(app: FastifyInstance, tx: any, errandId: string, stallId: string) {
  const s = await app.repos.stalls.byId(tx, stallId);
  if (!s || s.errandId !== errandId) throw new AppError(404, 'NOT_FOUND', 'Stall not found');
  return s;
}

const PriceItems = z.object({
  items: z.array(z.object({ id: z.string().uuid(), price_cents: z.number().int().nonnegative() })).min(1),
});

export default async function stallRoutes(app: FastifyInstance) {
  /** Runner enters the prices actually found at the stall. */
  app.post('/errands/:id/stalls/:sid/items', {
    preHandler: [app.auth.requireRole('runner'), app.limit(LIMITS.writes)],
    schema: { params: ApproveParams, body: PriceItems },
  }, async (req, reply) => {
    const { id, sid } = req.params as z.infer<typeof ApproveParams>;
    const { items } = req.body as z.infer<typeof PriceItems>;

    const total = await app.tx(req, async (tx) => {
      await app.repos.errands.assertRunner(tx, id, req.actor.id);
      await stallOfErrand(app, tx, id, sid);
      // The item ids in the body are equally untrusted: setPrices now scopes its UPDATE to
      // `WHERE stall_id = $sid AND id = ANY($ids)`, so an id from another stall matches
      // nothing instead of repricing a stranger's basket.
      await app.repos.stalls.setPrices(tx, sid, items);
      return app.repos.stalls.recomputeTotal(tx, sid);
    });

    return reply.send({ total_cents: total });
  });

  /** Runner submits the stall for approval. */
  app.post('/errands/:id/stalls/:sid/submit', {
    preHandler: app.auth.requireRole('runner'),
    schema: { params: ApproveParams },
  }, async (req, reply) => {
    const { id, sid } = req.params as z.infer<typeof ApproveParams>;

    await app.tx(req, async (tx) => {
      const e = await app.repos.errands.lockForUpdate(tx, id);
      await app.repos.errands.assertRunner(tx, id, req.actor.id);
      await stallOfErrand(app, tx, id, sid);
      await app.repos.stalls.assertHasEvidence(tx, sid);

      const to = nextStatus(e.status, 'submit_stall', 'runner');
      await tx.update(stall).set({ status: 'photographed' })
        .where(and(eq(stall.id, sid), eq(stall.errandId, id)));
      await tx.update(errand).set({ status: to, updatedAt: new Date() }).where(eq(errand.id, id));

      await enqueueOutbox(tx, 'notify', {
        accountId: e.requesterId, template: 'stall.submitted', vars: { errandId: id, stallId: sid },
      });
    });

    return reply.code(204).send();
  });

  /**
   * Requester approves a stall. Returns 202 — the card load is durable work, not a
   * request-scoped side effect. The client polls /tranches or waits on `tranche.loaded`.
   */
  app.post('/errands/:id/stalls/:sid/approve', {
    // Approval is the money path: it is idempotency-keyed, velocity-limited per errand, and
    // re-authenticated if the session looks like it moved country mid-errand.
    preHandler: [app.auth.requireRole('requester'), app.idempotency.required,
                 app.limit(LIMITS.approval), app.assertSessionIntegrity],
    config: { money: true },
    schema: { params: ApproveParams },
  }, async (req, reply) => {
    const { id, sid } = req.params as z.infer<typeof ApproveParams>;

    const result = await app.tx(req, async (tx) => {
      // SERIALIZABLE: two stalls approved at the same instant must not both fit under the cap.
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);

      const e = await app.repos.errands.lockForUpdate(tx, id);
      if (e.requesterId !== req.actor.id) throw new AppError(403, 'FORBIDDEN', 'Not your errand');

      const s = await stallOfErrand(app, tx, id, sid);

      let plan;
      try {
        plan = planTranche(
          { errandId: id, spendCapCents: cents(e.spendCapCents), spentCents: cents(e.spentCents) },
          { stallId: s.id, seq: s.seq, totalCents: cents(s.totalCents), tillNumber: s.tillNumber, status: s.status },
        );
      } catch (err) {
        if (err instanceof SpendCapExceededError) {
          throw new AppError(409, err.code, err.message, {
            requested_cents: err.requested, remaining_cents: err.remaining,
          });
        }
        throw err;
      }

      const c = await app.repos.cards.byErrand(tx, id);
      if (!c) throw new AppError(409, 'CARD_MISSING', 'Errand has no card; issuance has not completed');
      if (c.voidedAt) throw new AppError(409, 'CARD_VOIDED', 'Card is closed');

      // 1. Ledger: escrow → this errand's card float.
      await insertPostingGroup(tx, holdForTranche(id, e.requesterId, cents(plan.amountCents)));

      // 2. Escrow bookkeeping mirror, for cheap reads.
      await tx.update(escrow)
        .set({ heldCents: sql`${escrow.heldCents} - ${plan.amountCents}` })
        .where(eq(escrow.errandId, id));

      // 3. The tranche itself.
      const [row] = await tx.insert(tranche).values({
        cardId: c.id,
        stallId: plan.stallId,
        seq: plan.seq,
        amountCents: plan.amountCents,
        idemKey: plan.idemKey,
        status: 'pending',
      }).returning();

      // 4. Stall and errand state.
      await tx.update(stall)
        .set({ status: 'approved', approvedAt: new Date() })
        .where(and(eq(stall.id, sid), eq(stall.status, 'photographed')));

      await tx.update(errand).set({
        spentCents: sql`${errand.spentCents} + ${plan.amountCents}`,
        status: nextStatus(e.status, 'approve_stall', 'requester'),
        updatedAt: new Date(),
      }).where(eq(errand.id, id));

      // 5. Outbox — committed with everything above. Redis being down cannot lose this.
      await enqueueOutbox(tx, 'card.load', { trancheId: row!.id });

      return { tranche: row!, remaining: plan.remainingAfterCents };
    });

    return reply.code(202).send({
      tranche: {
        id: result.tranche.id,
        seq: result.tranche.seq,
        amount_cents: result.tranche.amountCents,
        status: result.tranche.status,
      },
      remaining_cap_cents: result.remaining,
      poll_after_ms: 1500,
    });
  });

  /** Requester declines a stall outright. No tranche, no money moves. */
  app.post('/errands/:id/stalls/:sid/decline', {
    preHandler: [app.auth.requireRole('requester'), app.limit(LIMITS.writes)],
    schema: { params: ApproveParams, body: z.object({ reason: z.string().min(1).max(280) }) },
  }, async (req, reply) => {
    const { id, sid } = req.params as z.infer<typeof ApproveParams>;
    // The reason is rendered to the runner in-app and in an SMS template. Normalised at the
    // boundary rather than trusted to every future render site.
    const reason = cleanProse('reason', (req.body as { reason: string }).reason, 280);

    await app.tx(req, async (tx) => {
      const e = await app.repos.errands.lockForUpdate(tx, id);
      if (e.requesterId !== req.actor.id) throw new AppError(403, 'FORBIDDEN', 'Not your errand');
      await stallOfErrand(app, tx, id, sid);

      await tx.update(stall).set({ status: 'declined' })
        .where(and(eq(stall.id, sid), eq(stall.errandId, id)));
      await enqueueOutbox(tx, 'notify', {
        accountId: e.runnerId, template: 'stall.declined', vars: { errandId: id, stallId: sid, reason },
      });
      await app.repos.errands.maybeAdvanceToHandover(tx, id);
    });

    return reply.code(204).send();
  });
}
