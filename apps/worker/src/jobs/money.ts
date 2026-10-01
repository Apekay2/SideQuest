// apps/worker/src/jobs/money.ts
// The money service's asynchronous half: issuing the card at assignment, voiding it at the
// end, settlement, refunds, expiry, and applying a Legal Operations ruling. The ledger is the
// truth throughout; the escrow row is a mirror synced after every posting that touches it.

import { insertPostingGroup, ledgerBalance, type Tx } from '@sidequest/db';
import {
  settle, chargeRequesterFee, refundEscrow, returnUnspent, rulingSplit, holdForTranche,
} from '@sidequest/domain/ledger/posting';
import { cents } from '@sidequest/domain/money/money';
import { trancheIdemKey } from '@sidequest/domain/card/tranche';
import { bonusEarned } from '@sidequest/domain/progress/eta';
import { nextStatus, isTerminal, type ErrandStatus } from '@sidequest/domain/errand/machine';
import { type Handler, type JobContext, publish, later, escrowBalance, syncEscrowMirror, str } from '../context.js';

/** Matches the delay errands.routes.ts schedules errand.expire with. */
const EXPIRE_GRACE_MINUTES = 120;

interface ErrandMoney {
  id: string; requester_id: string; runner_id: string | null; status: ErrandStatus; kind: string;
  funding_mode: 'upfront' | 'tranche'; spend_cap_cents: number; spent_cents: number;
  agreed_fee_cents: number | null; bonus_cents: number; deadline_at: Date | null; handover_at: Date | null;
  currency: 'KES'; title: string;
}

async function errandFor(tx: Tx, id: string): Promise<ErrandMoney | undefined> {
  const [e] = await tx<ErrandMoney[]>`
    SELECT id, requester_id, runner_id, status, kind, funding_mode, spend_cap_cents, spent_cents, agreed_fee_cents,
           bonus_cents, deadline_at, handover_at, currency, title
      FROM errand WHERE id = ${id} FOR UPDATE`;
  return e;
}

/**
 * Assignment → a one-time card with a hard ceiling at the cap. Upfront kinds load the whole
 * cap now, as a single tranche at seq 0: one code path, one ledger shape, one decline ladder.
 */
export const errandAssigned: Handler = async (payload, ctx) => {
  const errandId = str(payload, 'errandId');
  const { sql, issuer } = ctx.deps;
  const [e] = await sql<(ErrandMoney & { display_name: string })[]>`
    SELECT e.*, a.display_name FROM errand e JOIN account a ON a.id = e.runner_id WHERE e.id = ${errandId}`;
  if (!e || !e.runner_id) { ctx.log.warn({ errandId }, 'assigned errand has no runner'); return; }
  if (isTerminal(e.status)) return;

  // Idempotent at the issuer by key, and at the database by the card's UNIQUE errand_id.
  const issued = await issuer.createCard({
    errandId, ceilingCents: cents(e.spend_cap_cents), holderName: e.display_name, idemKey: `card:${errandId}`,
  });

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO card (errand_id, issuer_ref, last4, currency)
      VALUES (${errandId}, ${issued.issuerRef}, ${issued.last4}, ${e.currency})
      ON CONFLICT (errand_id) DO NOTHING`;
    const cp = await tx`SELECT 1 FROM errand_checkpoint WHERE errand_id = ${errandId} AND kind = 'assigned'`;
    if (cp.length === 0) await tx`INSERT INTO errand_checkpoint (errand_id, kind, reached_at) VALUES (${errandId}, 'assigned', now())`;
    await later(tx, 'eta.recompute', { errandId });

    if (e.funding_mode === 'upfront' && e.spend_cap_cents > 0) {
      const [c] = await tx<{ id: string }[]>`SELECT id FROM card WHERE errand_id = ${errandId}`;
      const existing = await tx`SELECT 1 FROM tranche WHERE card_id = ${c!.id} AND seq = 0`;
      if (existing.length === 0) {
        await insertPostingGroup(tx, holdForTranche({
          errandId, requesterId: e.requester_id, amountCents: cents(e.spend_cap_cents), currency: e.currency,
        }));
        await syncEscrowMirror(tx, errandId, e.requester_id);
        const [t] = await tx<{ id: string }[]>`
          INSERT INTO tranche (card_id, stall_id, seq, amount_cents, idem_key, status, currency)
          VALUES (${c!.id}, NULL, 0, ${e.spend_cap_cents}, ${trancheIdemKey(errandId, 0, 1)}, 'pending', ${e.currency})
          RETURNING id`;
        await tx`UPDATE errand SET spent_cents = spent_cents + ${e.spend_cap_cents} WHERE id = ${errandId}`;
        await later(tx, 'card.load', { trancheId: t!.id, errandId });
      }
    }
  });
  await publish(ctx.deps, e.runner_id, 'errand.awarded', { errand_id: errandId });
  await publish(ctx.deps, e.requester_id, 'errand.awarded', { errand_id: errandId });
};

/**
 * Void the card and bring any value left on it back to escrow, by the issuer's own balance.
 * If the errand has already ended without settlement (cancelled, expired), that escrow then
 * returns to the requester's wallet.
 */
export async function voidAndReturn(ctx: JobContext, errandId: string): Promise<void> {
  const { sql, issuer } = ctx.deps;
  const [c] = await sql<{ id: string; issuer_ref: string; voided_at: Date | null }[]>`
    SELECT id, issuer_ref, voided_at FROM card WHERE errand_id = ${errandId}`;
  if (!c || c.voided_at) return;
  const left = Number(await issuer.getBalance(c.issuer_ref));
  await issuer.voidCard({ issuerRef: c.issuer_ref, idemKey: `void:${errandId}` });
  await sql.begin(async (tx) => {
    const e = await errandFor(tx, errandId);
    if (!e) return;
    const marked = await tx`UPDATE card SET voided_at = now() WHERE id = ${c.id} AND voided_at IS NULL RETURNING id`;
    if (marked.length === 0) return;
    if (left > 0) {
      await insertPostingGroup(tx, returnUnspent({ errandId, requesterId: e.requester_id, amountCents: cents(left), currency: e.currency }));
    }
    if (e.status === 'cancelled' || e.status === 'expired') {
      const bal = await escrowBalance(tx, errandId, e.requester_id);
      if (bal > 0) {
        await insertPostingGroup(tx, refundEscrow({ errandId, requesterId: e.requester_id, escrowBalanceCents: cents(bal), currency: e.currency }));
      }
      await syncEscrowMirror(tx, errandId, e.requester_id, true);
    } else {
      await syncEscrowMirror(tx, errandId, e.requester_id);
    }
  });
}

export const cardVoid: Handler = async (payload, ctx) => {
  await voidAndReturn(ctx, str(payload, 'errandId'));
};

/**
 * Settlement, after the QR handover. The card is voided first so any unspent upfront value is
 * back in escrow before the escrow is divided. The requester's fee half is recognised here,
 * the runner's half is deducted inside settle(), and the on-time bonus is adjudicated on the
 * handover timestamp against the deadline — never on the ETA.
 */
export const errandSettle: Handler = async (payload, ctx) => {
  const errandId = str(payload, 'errandId');
  await voidAndReturn(ctx, errandId);

  const out = await ctx.deps.sql.begin(async (tx) => {
    const e = await errandFor(tx, errandId);
    if (!e || !e.runner_id) return null;
    if (e.status !== 'settled') { ctx.log.warn({ status: e.status }, 'settle on a non-settled errand; skipping'); return null; }
    const already = await tx`SELECT 1 FROM posting_group WHERE errand_id = ${errandId} AND reason = 'errand.settle'`;
    if (already.length) return null;

    const [fee] = await tx<{ requester_fee_cents: number; runner_fee_cents: number; requester_charged_at: Date | null }[]>`
      SELECT requester_fee_cents, runner_fee_cents, requester_charged_at FROM errand_fee WHERE errand_id = ${errandId} FOR UPDATE`;
    if (!fee) throw new Error(`errand ${errandId} settled without a frozen fee`);

    if (!fee.requester_charged_at && fee.requester_fee_cents > 0) {
      await insertPostingGroup(tx, chargeRequesterFee({
        errandId, requesterId: e.requester_id, feeCents: cents(fee.requester_fee_cents), currency: e.currency,
      }));
    }
    const earned = e.handover_at ? bonusEarned(e.handover_at.getTime(), e.deadline_at?.getTime() ?? null) : false;
    const reimbursement = await ledgerBalance(tx, { account: 'reimbursement_due', ownerId: e.runner_id, errandId });
    const escrow = await escrowBalance(tx, errandId, e.requester_id);

    const group = settle({
      errandId, requesterId: e.requester_id, runnerId: e.runner_id, currency: e.currency,
      escrowBalanceCents: cents(escrow),
      agreedFeeCents: cents(e.agreed_fee_cents ?? 0),
      runnerFeeCents: cents(fee.runner_fee_cents),
      bonusPaidCents: cents(earned && e.bonus_cents > 0 ? e.bonus_cents : 0),
      reimbursementCents: cents(reimbursement),
    });
    await insertPostingGroup(tx, group);
    await tx`UPDATE errand_fee SET requester_charged_at = COALESCE(requester_charged_at, now()), runner_deducted_at = now()
              WHERE errand_id = ${errandId}`;
    await tx`UPDATE errand SET bonus_earned = ${earned} WHERE id = ${errandId}`;
    await syncEscrowMirror(tx, errandId, e.requester_id, true);
    // The pair's history drives direct invites and "completed with you" on the map.
    await tx`
      INSERT INTO relationship (requester_id, runner_id, completed, last_at) VALUES (${e.requester_id}, ${e.runner_id}, 1, now())
      ON CONFLICT (requester_id, runner_id) DO UPDATE SET completed = relationship.completed + 1, last_at = now()`;
    await later(tx, 'notify', { accountId: e.runner_id, template: 'errand.settled_runner', vars: { errandId, amountCents: group.runnerTotalCents } });
    await later(tx, 'notify', { accountId: e.requester_id, template: 'errand.settled_requester', vars: { errandId, refundCents: group.refundCents } });
    return { e, runnerTotal: group.runnerTotalCents, refund: group.refundCents };
  });

  if (out) {
    await publish(ctx.deps, out.e.runner_id, 'errand.settled', { errand_id: errandId, earned_cents: out.runnerTotal });
    await publish(ctx.deps, out.e.requester_id, 'errand.settled', { errand_id: errandId, refund_cents: out.refund });
  }
};

/** A runner cancelled before shopping: the requester gets the whole escrow back. */
export const errandRefund: Handler = async (payload, ctx) => {
  const errandId = str(payload, 'errandId');
  await voidAndReturn(ctx, errandId);
  await ctx.deps.sql.begin(async (tx) => {
    const e = await errandFor(tx, errandId);
    if (!e) return;
    const bal = await escrowBalance(tx, errandId, e.requester_id);
    if (bal > 0) {
      await insertPostingGroup(tx, refundEscrow({ errandId, requesterId: e.requester_id, escrowBalanceCents: cents(bal), currency: e.currency }));
    }
    await syncEscrowMirror(tx, errandId, e.requester_id, true);
  });
};

/** Nobody took it: the errand expires and its escrow returns. */
export const errandExpire: Handler = async (payload, ctx) => {
  const errandId = str(payload, 'errandId');
  const who = await ctx.deps.sql.begin(async (tx) => {
    const e = await errandFor(tx, errandId);
    if (!e || e.runner_id || (e.status !== 'open' && e.status !== 'offered')) return null;
    // A timer is a wake-up, not a verdict: if it fires early (a retry, clock skew) the errand
    // is not yet expired, and nothing happens.
    const [due] = await tx<{ due: boolean }[]>`
      SELECT (auction_closes_at + make_interval(mins => ${EXPIRE_GRACE_MINUTES}) <= now()) AS due FROM errand WHERE id = ${errandId}`;
    if (!due?.due) return null;
    const from = e.status === 'offered' ? nextStatus('offered', 'offer_lapsed', 'system') : e.status;
    await tx`UPDATE errand SET status = ${nextStatus(from, 'auction_expired', 'system')}, offered_to = NULL, updated_at = now()
              WHERE id = ${errandId}`;
    await tx`UPDATE errand_offer SET outcome = 'lapsed', resolved_at = now() WHERE errand_id = ${errandId} AND outcome = 'pending'`;
    await tx`UPDATE bid SET status = 'lost' WHERE errand_id = ${errandId} AND status = 'sealed'`;
    const bal = await escrowBalance(tx, errandId, e.requester_id);
    if (bal > 0) {
      await insertPostingGroup(tx, refundEscrow({ errandId, requesterId: e.requester_id, escrowBalanceCents: cents(bal), currency: e.currency }));
    }
    await syncEscrowMirror(tx, errandId, e.requester_id, true);
    await later(tx, 'notify', { accountId: e.requester_id, template: 'errand.expired', vars: { errandId } });
    return e.requester_id;
  });
  await publish(ctx.deps, who, 'errand.expired', { errand_id: errandId });
};

/** A dispute freezes escrow and voids the card (the safety screen promises both). */
export const disputeOpened: Handler = async (payload, ctx) => {
  const errandId = str(payload, 'errandId');
  await ctx.deps.sql`UPDATE escrow SET frozen_at = COALESCE(frozen_at, now()) WHERE errand_id = ${errandId}`;
  await voidAndReturn(ctx, errandId);
  await ctx.deps.sql`UPDATE dispute SET status = 'evidence' WHERE id = ${str(payload, 'disputeId')} AND status = 'open'`;
};

/**
 * Apply a Legal Operations ruling: the only path that splits a frozen escrow. The split is
 * re-checked against the ledger here, because the officer saw a number at ruling time and the
 * card void may have returned value since.
 */
export const disputeRuled: Handler = async (payload, ctx) => {
  const errandId = str(payload, 'errandId');
  const rulingId = str(payload, 'rulingId');
  await voidAndReturn(ctx, errandId);
  const parties = await ctx.deps.sql.begin(async (tx) => {
    const e = await errandFor(tx, errandId);
    if (!e) return null;
    const [r] = await tx<{ requester_cents: number; runner_cents: number; dispute_id: string }[]>`
      SELECT requester_cents, runner_cents, dispute_id FROM ruling WHERE id = ${rulingId}`;
    if (!r) throw new Error('ruling not found');
    const done = await tx`SELECT 1 FROM posting_group WHERE errand_id = ${errandId} AND reason = 'dispute.ruling'`;
    if (done.length) return null;
    const bal = await escrowBalance(tx, errandId, e.requester_id);
    if (r.requester_cents + r.runner_cents !== bal) {
      // Throwing leaves the outbox row to retry and then park, which pages: a ruling that no
      // longer matches the escrow needs a human, not a best guess.
      throw new Error(`ruling split ${r.requester_cents + r.runner_cents} does not equal escrow ${bal}`);
    }
    if (bal > 0) {
      await insertPostingGroup(tx, rulingSplit({
        errandId, requesterId: e.requester_id, runnerId: e.runner_id ?? e.requester_id, currency: e.currency,
        escrowBalanceCents: cents(bal), requesterCents: cents(r.requester_cents), runnerCents: cents(r.runner_cents),
      }));
    }
    await syncEscrowMirror(tx, errandId, e.requester_id, true);
    if (e.status === 'disputed') {
      await tx`UPDATE errand SET status = ${nextStatus('disputed', 'resolve_dispute', 'legal_ops')}, updated_at = now() WHERE id = ${errandId}`;
    }
    await tx`UPDATE dispute SET status = 'closed' WHERE id = ${r.dispute_id}`;
    for (const who of [e.requester_id, e.runner_id]) {
      if (who) await later(tx, 'notify', { accountId: who, template: 'dispute.ruled', vars: { errandId } });
    }
    return [e.requester_id, e.runner_id];
  });
  for (const who of parties ?? []) await publish(ctx.deps, who, 'dispute.ruled', { errand_id: errandId });
};
