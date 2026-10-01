// apps/worker/src/jobs/payments.ts
// The payments service (06-services.md §6.1): it owns the rails and the callbacks. It records
// what the rail said and turns a confirmed payment into ledger postings; it never decides
// anything about an errand beyond "the funds it was waiting for have arrived".
//
// A callback is only acted on when it matches something WE initiated — a payment row by its
// checkout reference, a payout or till attempt by its conversation id. An unmatched callback
// is recorded and ignored, which is what turns a forged confirmation into a dead end.

import { insertPostingGroup, ledgerBalance } from '@sidequest/db';
import { topUp, fundEscrow, payout, payoutReversal, withdraw } from '@sidequest/domain/ledger/posting';
import { depositTotal } from '@sidequest/domain/pricing/fees';
import { nextStatus } from '@sidequest/domain/errand/machine';
import { cents } from '@sidequest/domain/money/money';
import { parseCallback } from '@sidequest/adapters';
import { metrics } from '@sidequest/observability';
import { type Handler, type JobContext, publish, later, str } from '../context.js';
import { completeTranche } from './card-load.job.js';

const EXPIRE_GRACE_MINUTES = 120;

async function msisdnOf(ctx: JobContext, accountId: string): Promise<string> {
  const [a] = await ctx.deps.sql<{ msisdn: string }[]>`SELECT msisdn FROM account WHERE id = ${accountId}`;
  if (!a) throw new Error('account not found');
  return a.msisdn;
}

/** STK push for a top-up or an errand deposit. */
export const paymentStk: Handler = async (payload, ctx) => {
  const paymentId = str(payload, 'paymentId');
  const [p] = await ctx.deps.sql<{ id: string; account_id: string; amount_cents: number; status: string; provider_ref: string | null; errand_id: string | null }[]>`
    SELECT id, account_id, amount_cents, status, provider_ref, errand_id FROM payment WHERE id = ${paymentId}`;
  // STK has no idempotency key at Safaricom, so the payment row is the guard: a push is sent
  // once, while the row is still `initiated`, and never again.
  if (!p || p.status !== 'initiated' || p.provider_ref) return;
  const claimed = await ctx.deps.sql`UPDATE payment SET status = 'pending' WHERE id = ${paymentId} AND status = 'initiated' RETURNING id`;
  if (claimed.length === 0) return;
  try {
    const { checkoutRef } = await ctx.deps.mpesa.stkPush({
      msisdn: await msisdnOf(ctx, p.account_id),
      amountCents: cents(p.amount_cents),
      accountRef: p.errand_id ? `SQ${p.errand_id.slice(0, 8)}` : 'SQWALLET',
      description: p.errand_id ? 'Side Qwest' : 'Top up',
      idemKey: paymentId,
    });
    await ctx.deps.sql`UPDATE payment SET provider_ref = ${checkoutRef} WHERE id = ${paymentId}`;
  } catch (err) {
    ctx.log.error({ err, paymentId }, 'stk push failed');
    await ctx.deps.sql`UPDATE payment SET status = 'failed', failure_code = 'push_failed' WHERE id = ${paymentId}`;
    await publish(ctx.deps, p.account_id, 'payment.failed', { payment_id: paymentId });
  }
};

/** Every Daraja callback lands here, from the webhook route or from the fake driver. */
export const mpesaCallback: Handler = async (payload, ctx) => {
  const kind = str(payload, 'kind') as 'stk' | 'result' | 'timeout';
  const body = payload.body;
  const result = parseCallback(kind === 'stk' ? 'stk' : 'result', body);

  await ctx.deps.sql`
    INSERT INTO mpesa_event (direction, merchant_ref, checkout_ref, amount_cents, result_code, raw)
    VALUES (${kind === 'stk' ? 'in' : 'out'}, ${result ? `${result.kind}:${result.ref}` : null}, ${result?.ref ?? null},
            ${result?.amountCents ?? 0}, ${result?.resultCode ?? null}, ${ctx.deps.sql.json((body ?? {}) as never)})
    ON CONFLICT (merchant_ref) DO NOTHING`;
  if (!result) { metrics.increment('mpesa.callback_unparsed'); return; }

  if (result.kind === 'stk') return onStk(ctx, result);
  if (result.kind === 'till') return onTill(ctx, result);
  return onB2c(ctx, result);
};

async function onStk(ctx: JobContext, r: NonNullable<ReturnType<typeof parseCallback>>) {
  const { sql, cfg } = ctx.deps;
  const out = await sql.begin(async (tx) => {
    const [p] = await tx<{ id: string; account_id: string; errand_id: string | null; amount_cents: number; status: string }[]>`
      SELECT id, account_id, errand_id, amount_cents, status FROM payment
       WHERE provider = 'daraja' AND provider_ref = ${r.ref} FOR UPDATE`;
    if (!p) { metrics.increment('mpesa.callback_unmatched', { kind: 'stk' }); return null; }
    if (p.status === 'confirmed' || p.status === 'failed') return null;   // duplicate callback
    if (!r.ok) {
      await tx`UPDATE payment SET status = 'failed', failure_code = ${r.resultCode} WHERE id = ${p.id}`;
      return { p, ok: false as const };
    }
    // The amount the RAIL reports is what is credited; a mismatch with what we asked for is a
    // reconciliation page, not a silent acceptance of either figure.
    if (r.amountCents !== null && r.amountCents !== p.amount_cents) {
      await tx`UPDATE payment SET status = 'failed', failure_code = 'amount_mismatch' WHERE id = ${p.id}`;
      metrics.increment('mpesa.amount_mismatch');
      return { p, ok: false as const };
    }
    await tx`UPDATE payment SET status = 'confirmed', confirmed_at = now() WHERE id = ${p.id}`;
    await insertPostingGroup(tx, topUp({ userId: p.account_id, amountCents: cents(p.amount_cents), currency: 'KES' }));

    // A deposit for an errand: fund it now, from the wallet the push just credited.
    if (p.errand_id) {
      const [e] = await tx<{ id: string; status: string; requester_id: string; spend_cap_cents: number; max_fee_cents: number;
                             bonus_cents: number; auction_minutes: number; currency: 'KES' }[]>`
        SELECT id, status, requester_id, spend_cap_cents, max_fee_cents, bonus_cents, auction_minutes, currency
          FROM errand WHERE id = ${p.errand_id} FOR UPDATE`;
      if (e && e.status === 'awaiting_funds') {
        const deposit = depositTotal({
          agreedFeeCents: cents(e.max_fee_cents), goodsCapCents: cents(e.spend_cap_cents),
          bonusCents: cents(e.bonus_cents), rateBps: cfg.PLATFORM_FEE_BPS,
        }).depositCents;
        const wallet = await ledgerBalance(tx, { account: 'user_wallet', ownerId: e.requester_id });
        if (wallet >= deposit) {
          await tx`INSERT INTO escrow (errand_id, funded_cents, held_cents, currency) VALUES (${e.id}, ${deposit}, ${deposit}, ${e.currency})`;
          await insertPostingGroup(tx, fundEscrow({ errandId: e.id, userId: e.requester_id, amountCents: cents(deposit), currency: e.currency }));
          await tx`UPDATE errand SET status = ${nextStatus('awaiting_funds', 'fund', 'system')}, updated_at = now(),
                          auction_closes_at = now() + make_interval(mins => ${e.auction_minutes})
                    WHERE id = ${e.id}`;
          await later(tx, 'errand.published', { errandId: e.id });
          await later(tx, 'errand.expire', { errandId: e.id }, e.auction_minutes * 60 + EXPIRE_GRACE_MINUTES * 60);
        }
      }
    }
    return { p, ok: true as const };
  });
  if (out) {
    await publish(ctx.deps, out.p.account_id, out.ok ? 'payment.confirmed' : 'payment.failed',
      { payment_id: out.p.id, errand_id: out.p.errand_id });
  }
}

async function onTill(ctx: JobContext, r: NonNullable<ReturnType<typeof parseCallback>>) {
  const [a] = await ctx.deps.sql<{ id: string; tranche_id: string; result: string }[]>`
    SELECT id, tranche_id, result FROM card_attempt WHERE rung = 'mpesa_till' AND provider_ref = ${r.ref}`;
  if (!a) { metrics.increment('mpesa.callback_unmatched', { kind: 'till' }); return; }
  if (a.result !== 'pending') return;
  if (r.ok) {
    await completeTranche(ctx, a.tranche_id, r.receipt ?? r.ref, { id: a.id }, 'till');
    return;
  }
  await ctx.deps.sql.begin(async (tx) => {
    await tx`UPDATE card_attempt SET result = 'declined', provider_code = ${`mpesa_${r.resultCode}`}, settled_at = now()
              WHERE id = ${a.id} AND result = 'pending'`;
    await later(tx, 'card.load', { trancheId: a.tranche_id });
  });
}

async function onB2c(ctx: JobContext, r: NonNullable<ReturnType<typeof parseCallback>>) {
  const { sql } = ctx.deps;
  const out = await sql.begin(async (tx) => {
    const [po] = await tx<{ id: string; runner_id: string; amount_cents: number; status: string; currency: 'KES' }[]>`
      SELECT id, runner_id, amount_cents, status, currency FROM payout WHERE provider_ref = ${r.ref} FOR UPDATE`;
    if (po) {
      if (po.status !== 'sent') return null;
      if (r.ok) {
        await tx`UPDATE payout SET status = 'confirmed', confirmed_at = now() WHERE id = ${po.id}`;
      } else {
        // The money never left: put it back in earnings.
        await tx`UPDATE payout SET status = 'failed', failure_code = ${r.resultCode} WHERE id = ${po.id}`;
        await insertPostingGroup(tx, payoutReversal({ runnerId: po.runner_id, amountCents: cents(po.amount_cents), currency: po.currency }));
      }
      await later(tx, 'notify', { accountId: po.runner_id, template: r.ok ? 'payout.confirmed' : 'payout.failed', vars: { amountCents: po.amount_cents } });
      return { who: po.runner_id, event: r.ok ? 'payout.confirmed' : 'payout.failed', id: po.id };
    }
    const [pm] = await tx<{ id: string; account_id: string; amount_cents: number; status: string }[]>`
      SELECT id, account_id, amount_cents, status FROM payment
       WHERE direction = 'out' AND provider = 'daraja' AND provider_ref = ${r.ref} FOR UPDATE`;
    if (!pm) { metrics.increment('mpesa.callback_unmatched', { kind: 'b2c' }); return null; }
    if (pm.status !== 'pending') return null;
    if (r.ok) {
      await tx`UPDATE payment SET status = 'confirmed', confirmed_at = now() WHERE id = ${pm.id}`;
    } else {
      await tx`UPDATE payment SET status = 'failed', failure_code = ${r.resultCode} WHERE id = ${pm.id}`;
      await insertPostingGroup(tx, topUp({ userId: pm.account_id, amountCents: cents(pm.amount_cents), currency: 'KES' }));
    }
    return { who: pm.account_id, event: r.ok ? 'withdraw.confirmed' : 'withdraw.failed', id: pm.id };
  });
  if (out) await publish(ctx.deps, out.who, out.event, { id: out.id });
}

/**
 * Runner cash-out. The ledger moves first (earnings → out), then the rail is called; a failed
 * B2C result reverses it. The reverse order would let a runner request twice against one
 * balance while the first B2C was in flight.
 */
export const payoutSend: Handler = async (payload, ctx) => {
  const payoutId = str(payload, 'payoutId');
  const { sql, mpesa } = ctx.deps;
  const po = await sql.begin(async (tx) => {
    const [po] = await tx<{ id: string; runner_id: string; amount_cents: number; status: string; idem_key: string; currency: 'KES' }[]>`
      SELECT id, runner_id, amount_cents, status, idem_key, currency FROM payout WHERE id = ${payoutId} FOR UPDATE`;
    if (!po || po.status !== 'queued') return null;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'earnings:' + po.runner_id}))`;
    const available = await ledgerBalance(tx, { account: 'runner_earnings', ownerId: po.runner_id });
    if (available < po.amount_cents) {
      await tx`UPDATE payout SET status = 'failed', failure_code = 'insufficient_earnings' WHERE id = ${po.id}`;
      return null;
    }
    await insertPostingGroup(tx, payout({ runnerId: po.runner_id, amountCents: cents(po.amount_cents), currency: po.currency }));
    await tx`UPDATE payout SET status = 'sent' WHERE id = ${po.id}`;
    return po;
  });
  if (!po) return;
  try {
    const { conversationId } = await mpesa.b2c({
      msisdn: await msisdnOf(ctx, po.runner_id), amountCents: cents(po.amount_cents), remarks: 'Side Qwest earnings', idemKey: po.idem_key,
    });
    await sql`UPDATE payout SET provider_ref = ${conversationId} WHERE id = ${po.id}`;
  } catch (err) {
    ctx.log.error({ err, payoutId }, 'b2c request failed; reversing');
    await sql.begin(async (tx) => {
      const moved = await tx`UPDATE payout SET status = 'failed', failure_code = 'request_failed' WHERE id = ${po.id} AND status = 'sent' RETURNING id`;
      if (moved.length) await insertPostingGroup(tx, payoutReversal({ runnerId: po.runner_id, amountCents: cents(po.amount_cents), currency: po.currency }));
    });
  }
};

/** Requester withdrawal to M-Pesa. Same order as a payout: ledger first, rail second. */
export const paymentWithdraw: Handler = async (payload, ctx) => {
  const paymentId = str(payload, 'paymentId');
  const { sql, mpesa } = ctx.deps;
  const pm = await sql.begin(async (tx) => {
    const [pm] = await tx<{ id: string; account_id: string; amount_cents: number; status: string; idem_key: string }[]>`
      SELECT id, account_id, amount_cents, status, idem_key FROM payment WHERE id = ${paymentId} AND direction = 'out' FOR UPDATE`;
    if (!pm || pm.status !== 'initiated') return null;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'wallet:' + pm.account_id}))`;
    const bal = await ledgerBalance(tx, { account: 'user_wallet', ownerId: pm.account_id });
    if (bal < pm.amount_cents) {
      await tx`UPDATE payment SET status = 'failed', failure_code = 'insufficient_funds' WHERE id = ${pm.id}`;
      return null;
    }
    await insertPostingGroup(tx, withdraw({ userId: pm.account_id, amountCents: cents(pm.amount_cents), currency: 'KES' }));
    await tx`UPDATE payment SET status = 'pending' WHERE id = ${pm.id}`;
    return pm;
  });
  if (!pm) return;
  try {
    const { conversationId } = await mpesa.b2c({
      msisdn: await msisdnOf(ctx, pm.account_id), amountCents: cents(pm.amount_cents), remarks: 'Side Qwest refund', idemKey: pm.idem_key,
    });
    await sql`UPDATE payment SET provider_ref = ${conversationId} WHERE id = ${pm.id}`;
  } catch (err) {
    ctx.log.error({ err, paymentId }, 'withdraw b2c failed; reversing');
    await sql.begin(async (tx) => {
      const moved = await tx`UPDATE payment SET status = 'failed', failure_code = 'request_failed' WHERE id = ${pm.id} AND status = 'pending' RETURNING id`;
      if (moved.length) await insertPostingGroup(tx, topUp({ userId: pm.account_id, amountCents: cents(pm.amount_cents), currency: 'KES' }));
    });
  }
};

/** Card issuer events: recorded for reconciliation. Authorisation decisions are the issuer's. */
export const issuerEvent: Handler = async (payload, ctx) => {
  ctx.log.info({ type: (payload.body as { type?: string } | undefined)?.type }, 'issuer event');
  metrics.increment('issuer.event');
};
