// apps/api/src/routes/wallet.routes.ts
// Wallet, top-up, withdrawal, runner earnings and payouts. Balances are read from the ledger,
// never from a mirror column. Every rail call is the payments service's job, reached through
// the outbox, and every confirmation arrives by webhook — never on the client's word.

import type { FastifyInstance } from 'fastify';
import { TopUp, Withdraw, PayoutRequest, type Wallet, type Earnings } from '@sidequest/contracts';
import { enqueueOutbox, ledgerBalance, type Tx } from '@sidequest/db';
import { AppError, notFound } from '../plugins/errors.js';
import { LIMITS } from '../plugins/rate-limit.js';
import { parse, ids } from '../lib/validate.js';

function wholeShillings(amount: number) {
  if (amount % 100 !== 0) throw new AppError(400, 'VALIDATION', 'M-Pesa amounts must be whole shillings');
}

/** Money already promised out of an account but not yet posted: pending payouts/withdrawals. */
async function reserved(tx: Tx, accountId: string, kind: 'payout' | 'withdraw'): Promise<number> {
  const [r] = kind === 'payout'
    ? await tx<{ n: number }[]>`SELECT COALESCE(sum(amount_cents), 0)::bigint AS n FROM payout
                                 WHERE runner_id = ${accountId} AND status = 'queued'`
    : await tx<{ n: number }[]>`SELECT COALESCE(sum(amount_cents), 0)::bigint AS n FROM payment
                                 WHERE account_id = ${accountId} AND direction = 'out' AND status IN ('initiated','pending')`;
  return r!.n;
}

export default async function walletRoutes(app: FastifyInstance) {
  const { cfg } = app.deps;

  app.get('/wallet', { preHandler: app.requireAuth }, async (req): Promise<Wallet> => {
    const me = req.actor!.id;
    return app.tx(req, async (tx) => {
      const balance = await ledgerBalance(tx, { account: 'user_wallet', ownerId: me });
      const escrow = await tx<{ errand_id: string; title: string; held_cents: number }[]>`
        SELECT g.errand_id, e.title, sum(p.amount_cents)::bigint AS held_cents
          FROM posting p JOIN posting_group g ON g.id = p.group_id JOIN errand e ON e.id = g.errand_id
         WHERE p.account = 'escrow_hold' AND p.owner_id = ${me}
         GROUP BY g.errand_id, e.title HAVING sum(p.amount_cents) <> 0
         ORDER BY max(p.created_at) DESC`;
      const recent = await tx<{ id: number; reason: string; amount_cents: number; created_at: Date }[]>`
        SELECT p.id, g.reason, p.amount_cents, p.created_at
          FROM posting p JOIN posting_group g ON g.id = p.group_id
         WHERE p.account = 'user_wallet' AND p.owner_id = ${me}
         ORDER BY p.id DESC LIMIT 20`;
      return {
        currency: 'KES',
        balance_cents: balance,
        escrow,
        recent: recent.map((r) => ({ id: String(r.id), reason: r.reason, amount_cents: r.amount_cents, at: r.created_at.toISOString() })),
      };
    });
  });

  app.post('/wallet/topup', {
    preHandler: [app.requireEntitlement('wallet.topup'), app.idempotent, app.limit(LIMITS.topup), app.assertSessionIntegrity],
    config: { money: true },
  }, async (req, reply) => {
    const { amount_cents } = parse(TopUp, req.body);
    wholeShillings(amount_cents);
    const p = await app.tx(req, async (tx) => {
      const [p] = await tx<{ id: string }[]>`
        INSERT INTO payment (account_id, rail, direction, amount_cents, idem_key, provider, currency, expires_at)
        VALUES (${req.actor!.id}, 'mpesa_stk', 'in', ${amount_cents}, ${'topup:' + req.actor!.id + ':' + req.idempotency!.key},
                'daraja', 'KES', now() + interval '10 minutes')
        RETURNING id`;
      await enqueueOutbox(tx, 'payment.stk', { paymentId: p!.id, purpose: 'topup' }, { actorId: req.actor!.id });
      return p!;
    });
    return reply.code(202).send({ payment_id: p.id, status: 'initiated', amount_cents });
  });

  app.get('/payments/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = ids(req.params, 'id');
    const [p] = await app.tx(req, (tx) => tx`
      SELECT id, rail, direction, amount_cents, status, failure_code, created_at, confirmed_at, errand_id
        FROM payment WHERE id = ${id}`);
    if (!p) throw notFound('Payment not found');
    return p;
  });

  /** Requester refunds only: unspent wallet balance back to their own number. */
  app.post('/wallet/withdraw', {
    preHandler: [app.requireRole('requester'), app.idempotent, app.limit(LIMITS.payout), app.assertSessionIntegrity],
    config: { money: true },
  }, async (req, reply) => {
    const { amount_cents } = parse(Withdraw, req.body);
    wholeShillings(amount_cents);
    const me = req.actor!.id;
    const p = await app.tx(req, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'wallet:' + me}))`;
      const available = (await ledgerBalance(tx, { account: 'user_wallet', ownerId: me })) - (await reserved(tx, me, 'withdraw'));
      if (amount_cents > available) {
        throw new AppError(409, 'INSUFFICIENT_FUNDS', 'That is more than your available balance', { available_cents: available });
      }
      const [p] = await tx<{ id: string }[]>`
        INSERT INTO payment (account_id, rail, direction, amount_cents, idem_key, provider, currency)
        VALUES (${me}, 'mpesa_stk', 'out', ${amount_cents}, ${'withdraw:' + me + ':' + req.idempotency!.key}, 'daraja', 'KES')
        RETURNING id`;
      await enqueueOutbox(tx, 'payment.withdraw', { paymentId: p!.id }, { actorId: me });
      return p!;
    });
    return reply.code(202).send({ payment_id: p.id, status: 'initiated', amount_cents });
  });

  app.get('/earnings', { preHandler: app.requireRole('runner') }, async (req): Promise<Earnings> => {
    const me = req.actor!.id;
    return app.tx(req, async (tx) => {
      const available = await ledgerBalance(tx, { account: 'runner_earnings', ownerId: me });
      const owed = await ledgerBalance(tx, { account: 'reimbursement_due', ownerId: me });
      const [life] = await tx<{ n: number }[]>`
        SELECT COALESCE(sum(amount_cents) FILTER (WHERE amount_cents > 0), 0)::bigint AS n
          FROM posting WHERE account = 'runner_earnings' AND owner_id = ${me}`;
      const payouts = await tx<{ id: string; amount_cents: number; status: string; created_at: Date }[]>`
        SELECT id, amount_cents, status, created_at FROM payout WHERE runner_id = ${me} ORDER BY created_at DESC LIMIT 20`;
      const pending = await reserved(tx, me, 'payout');
      return {
        currency: 'KES',
        available_cents: available - pending,
        reimbursements_owed_cents: owed,
        lifetime_cents: life!.n,
        payouts: payouts.map((p) => ({ id: p.id, amount_cents: p.amount_cents, status: p.status, at: p.created_at.toISOString() })),
        min_payout_cents: cfg.MIN_PAYOUT_CENTS,
      };
    });
  });

  /** Cash-out to the registered MSISDN. Min KSh 100 (config), limited per day. */
  app.post('/payouts', {
    preHandler: [app.requireEntitlement('payout.request'), app.requireRole('runner'), app.idempotent,
                 app.limit(LIMITS.payout), app.assertSessionIntegrity],
    config: { money: true },
  }, async (req, reply) => {
    const { amount_cents } = parse(PayoutRequest, req.body);
    if (amount_cents < cfg.MIN_PAYOUT_CENTS) {
      throw new AppError(400, 'VALIDATION', 'Below the minimum payout', { min_payout_cents: cfg.MIN_PAYOUT_CENTS });
    }
    wholeShillings(amount_cents);
    const me = req.actor!.id;
    const payout = await app.tx(req, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'earnings:' + me}))`;
      const available = (await ledgerBalance(tx, { account: 'runner_earnings', ownerId: me })) - (await reserved(tx, me, 'payout'));
      if (amount_cents > available) {
        throw new AppError(409, 'INSUFFICIENT_FUNDS', 'That is more than your available earnings', { available_cents: available });
      }
      const [p] = await tx<{ id: string; status: string; created_at: Date }[]>`
        INSERT INTO payout (runner_id, amount_cents, idem_key, currency)
        VALUES (${me}, ${amount_cents}, ${'payout:' + me + ':' + req.idempotency!.key}, 'KES')
        RETURNING id, status, created_at`;
      await enqueueOutbox(tx, 'payout.send', { payoutId: p!.id }, { actorId: me });
      return p!;
    });
    return reply.code(202).send({ id: payout.id, amount_cents, status: payout.status });
  });

  app.get('/payouts/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = ids(req.params, 'id');
    const [p] = await app.tx(req, (tx) => tx`
      SELECT id, amount_cents, status, failure_code, created_at, confirmed_at FROM payout WHERE id = ${id}`);
    if (!p) throw notFound('Payout not found');
    return p;
  });
}
