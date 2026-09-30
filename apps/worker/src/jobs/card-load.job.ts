// apps/worker/src/jobs/card-load.job.ts
// Executes one rung of the ladder per run, then either finishes or re-enqueues itself.
// One rung per job means every rung is independently retryable and independently traced.
//
// Re-enqueues go through the outbox with a delay rather than straight onto the queue, so a
// retry is as durable as the approval that started it.

import type { Tx } from '@sidequest/db';
import { insertPostingGroup } from '@sidequest/db';
import { nextStep, type Attempt } from '@sidequest/domain/card/decline-ladder';
import { captureSpend, reverseTranche, reimbursementDue } from '@sidequest/domain/ledger/posting';
import { cents } from '@sidequest/domain/money/money';
import { MpesaAmountError } from '@sidequest/domain/rails/mpesa.port';
import { type Handler, type JobContext, publish, later, syncEscrowMirror, str } from '../context.js';
import { maybeAdvanceToHandover } from './shared.js';

const CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;

interface TrancheCtx {
  id: string; card_id: string; stall_id: string; seq: number; amount_cents: number; status: string;
  idem_key: string; reimbursement_confirmed: boolean | null; currency: 'KES';
  issuer_ref: string; errand_id: string; requester_id: string; runner_id: string | null;
  spend_cap_cents: number; spent_cents: number; till_number: string | null;
}

async function loadCtx(tx: Tx, trancheId: string): Promise<TrancheCtx | undefined> {
  const [t] = await tx<TrancheCtx[]>`
    SELECT t.id, t.card_id, t.stall_id, t.seq, t.amount_cents, t.status, t.idem_key, t.reimbursement_confirmed,
           t.currency, c.issuer_ref, e.id AS errand_id, e.requester_id, e.runner_id, e.spend_cap_cents,
           e.spent_cents, s.till_number
      FROM tranche t
      JOIN card c ON c.id = t.card_id
      JOIN errand e ON e.id = c.errand_id
      LEFT JOIN stall s ON s.id = t.stall_id
     WHERE t.id = ${trancheId}`;
  return t;
}

/**
 * The one writer for a successful load, whichever rung produced it and whether it came from
 * the live call, the crash-replay reconciliation or a till callback. Guarded on
 * `status = 'pending'` so a replay cannot capture the same spend twice.
 */
export async function completeTranche(
  ctx: JobContext, trancheId: string, providerRef: string,
  attemptWhere: { id?: string; idemKey?: string }, via: 'card' | 'till' = 'card',
) {
  const done = await ctx.deps.sql.begin(async (tx) => {
    const t = await loadCtx(tx, trancheId);
    if (!t) return null;
    if (attemptWhere.id) {
      await tx`UPDATE card_attempt SET result = 'success', provider_ref = ${providerRef}, settled_at = now() WHERE id = ${attemptWhere.id}`;
    } else if (attemptWhere.idemKey) {
      await tx`UPDATE card_attempt SET result = 'success', provider_ref = ${providerRef}, settled_at = now()
                WHERE tranche_id = ${trancheId} AND idem_key = ${attemptWhere.idemKey}`;
    }
    const moved = await tx`UPDATE tranche SET status = 'loaded' WHERE id = ${trancheId} AND status = 'pending' RETURNING id`;
    if (moved.length === 0) { ctx.log.info('tranche already loaded; not re-capturing'); return null; }
    // Only a card rung puts value on the card; a till payment went straight to the vendor.
    if (via === 'card') await tx`UPDATE card SET loaded_cents = loaded_cents + ${t.amount_cents} WHERE id = ${t.card_id}`;
    await insertPostingGroup(tx, captureSpend({ errandId: t.errand_id, amountCents: cents(t.amount_cents), currency: t.currency }));
    await later(tx, 'notify', {
      accountId: t.runner_id, template: 'card.ready',
      vars: { errandId: t.errand_id, stallId: t.stall_id, amountCents: t.amount_cents },
    });
    await maybeAdvanceToHandover(tx, t.errand_id);
    return t;
  });
  if (done) {
    for (const who of [done.requester_id, done.runner_id]) {
      await publish(ctx.deps, who, 'tranche.loaded', { errand_id: done.errand_id, tranche_id: trancheId, stall_id: done.stall_id });
    }
  }
}

export const cardLoad: Handler = async (payload, ctx) => {
  const trancheId = str(payload, 'trancheId');
  const { sql, issuer, mpesa } = ctx.deps;
  const log = ctx.log.child({ job: 'card.load', trancheId });

  const t = await sql.begin((tx) => loadCtx(tx, trancheId));
  if (!t) { log.error('tranche vanished'); return; }
  if (t.status === 'loaded' || t.status === 'reversed' || t.status === 'failed') { log.info('already resolved'); return; }
  if (!t.runner_id) { log.error('errand has no runner; ladder cannot run'); return; }

  const rows = await sql<{ id: string; rung: Attempt['rung']; result: Attempt['result']; provider_code: string | null;
                           idem_key: string; created_at: Date }[]>`
    SELECT id, rung, result, provider_code, idem_key, created_at FROM card_attempt WHERE tranche_id = ${trancheId} ORDER BY created_at`;
  const attempts: Attempt[] = rows.map((a) => ({ rung: a.rung, result: a.result, code: a.provider_code }));
  const requestedAt = rows.find((a) => a.rung === 'reimbursement')?.created_at;

  // The reimbursement attempt row is written `pending` while we wait for the requester. The
  // ladder reads a pending attempt as "wait", so an answered request is resolved to `error`
  // first — the answer itself travels in reimbursement_confirmed.
  const reimb = rows.find((a) => a.rung === 'reimbursement' && a.result === 'pending');
  const windowExpired = requestedAt !== undefined && Date.now() - requestedAt.getTime() > CONFIRMATION_WINDOW_MS;
  if (reimb && (t.reimbursement_confirmed !== null || windowExpired)) {
    await sql`UPDATE card_attempt SET result = 'error', settled_at = now() WHERE id = ${reimb.id} AND result = 'pending'`;
    const i = attempts.findIndex((a) => a.rung === 'reimbursement' && a.result === 'pending');
    if (i >= 0) attempts[i] = { ...attempts[i]!, result: 'error' };
  }

  const step = nextStep({
    attempts,
    amountCents: cents(t.amount_cents),
    // The tranche's own amount was added to spent at approval; the ladder asks how much of
    // the cap this tranche may still use, so it is added back.
    remainingCapCents: cents(t.spend_cap_cents - t.spent_cents + t.amount_cents),
    tillNumber: t.till_number,
    reimbursementConfirmed: t.reimbursement_confirmed,
    confirmationWindowExpired: windowExpired,
  });

  log.info({ step: step.action }, 'ladder step');

  switch (step.action) {
    case 'load_card': {
      const idemKey = `${t.idem_key}:${step.rung}`;
      const [attempt] = await sql<{ id: string }[]>`
        INSERT INTO card_attempt (tranche_id, rung, idem_key, result)
        VALUES (${trancheId}, ${step.rung}, ${idemKey}, 'pending')
        ON CONFLICT (idem_key) DO NOTHING RETURNING id`;

      // A pending attempt row that already exists means a previous run got as far as
      // calling the issuer and then died. Returning here (the old behaviour) left a card
      // that may hold real money with a tranche stuck at `pending`: the runner is never
      // told the card is ready, the ledger never records the capture, and the nightly
      // reconciliation reports an issuer/ledger divergence a human has to unpick.
      // Ask the issuer what happened, by the same idempotency key, and finish the job.
      if (!attempt) {
        const [existing] = await sql<{ result: string }[]>`
          SELECT result FROM card_attempt WHERE tranche_id = ${trancheId} AND idem_key = ${idemKey}`;
        if (existing && existing.result !== 'pending') { log.info('attempt already resolved'); return; }
        log.warn('replaying an interrupted issuer call; reconciling by idempotency key');
        const prior = await issuer.getLoad({ issuerRef: t.issuer_ref, idemKey });
        if (prior.status === 'unknown') {
          // Never assume. Try again shortly; the reconciliation job pages if a tranche stays
          // pending for an hour.
          await sql.begin((tx) => later(tx, 'card.load', { trancheId }, 5));
          return;
        }
        if (prior.status === 'succeeded') return completeTranche(ctx, trancheId, prior.providerRef, { idemKey });
        return recordFailure({ idemKey }, prior.code, false);
      }

      const res = await issuer.loadCard({ issuerRef: t.issuer_ref, amountCents: cents(t.amount_cents), idemKey });
      if (res.ok) return completeTranche(ctx, trancheId, res.providerRef, { id: attempt.id });
      return recordFailure({ id: attempt.id }, res.code, res.retryable);
    }

    case 'pay_till': {
      const idemKey = `${t.idem_key}:till`;
      const [attempt] = await sql<{ id: string }[]>`
        INSERT INTO card_attempt (tranche_id, rung, idem_key, result)
        VALUES (${trancheId}, 'mpesa_till', ${idemKey}, 'pending')
        ON CONFLICT (idem_key) DO NOTHING RETURNING id`;
      if (!attempt) return;
      try {
        // Result arrives on the Daraja callback (payments.ts), which completes or fails the
        // attempt and wakes this job again.
        const { conversationId } = await mpesa.payTill({
          tillNumber: step.tillNumber, amountCents: step.amountCents,
          reference: `SQ-${t.errand_id.slice(0, 8)}-${t.seq}`, idemKey,
        });
        await sql`UPDATE card_attempt SET provider_ref = ${conversationId} WHERE id = ${attempt.id}`;
      } catch (err) {
        // A till cannot take cents, and a rail outage is not a decline: either way this rung
        // is over and the ladder moves on to the next.
        const code = err instanceof MpesaAmountError ? 'not_whole_shilling' : 'rail_unavailable';
        await sql`UPDATE card_attempt SET result = 'error', provider_code = ${code}, settled_at = now() WHERE id = ${attempt.id}`;
        await sql.begin((tx) => later(tx, 'card.load', { trancheId }, 1));
      }
      return;
    }

    case 'request_reimbursement': {
      const idemKey = `${t.idem_key}:reimb`;
      await sql.begin(async (tx) => {
        const ins = await tx`
          INSERT INTO card_attempt (tranche_id, rung, idem_key, result)
          VALUES (${trancheId}, 'reimbursement', ${idemKey}, 'pending')
          ON CONFLICT (idem_key) DO NOTHING RETURNING id`;
        if (ins.length === 0) return;
        await later(tx, 'notify', {
          accountId: t.requester_id, template: 'ladder.reimbursement_requested',
          vars: { errandId: t.errand_id, trancheId, amountCents: step.amountCents },
        });
        // Wake when the window closes, whether or not the requester answered.
        await later(tx, 'card.load', { trancheId, wake: 'reimbursement_window' }, CONFIRMATION_WINDOW_MS / 1000 + 1);
      });
      await publish(ctx.deps, t.requester_id, 'reimbursement.requested', { errand_id: t.errand_id, tranche_id: trancheId, amount_cents: step.amountCents });
      return;
    }

    case 'pay_reimbursement': {
      await sql.begin(async (tx) => {
        // WAS: `.where(eq(a.trancheId, id) && eq(a.rung, 'reimbursement'))`. JavaScript `&&`
        // on two SQL predicate objects evaluates to the SECOND one, so this UPDATE ran as
        // `WHERE rung = 'reimbursement'` across the WHOLE TABLE — marking every pending
        // reimbursement attempt on every errand in the system as a success, on any single
        // cash reimbursement. The most expensive character in the codebase. In plain SQL the
        // two predicates are simply both there.
        await tx`UPDATE card_attempt SET result = 'success', settled_at = now()
                  WHERE tranche_id = ${trancheId} AND rung = 'reimbursement'`;
        const moved = await tx`UPDATE tranche SET status = 'loaded' WHERE id = ${trancheId} AND status = 'pending' RETURNING id`;
        if (moved.length === 0) return;
        await insertPostingGroup(tx, reimbursementDue({
          errandId: t.errand_id, runnerId: t.runner_id!, amountCents: cents(step.amountCents), currency: t.currency,
        }));
        await later(tx, 'notify', {
          accountId: t.runner_id, template: 'ladder.pay_cash',
          vars: { errandId: t.errand_id, stallId: t.stall_id, amountCents: step.amountCents },
        });
        await maybeAdvanceToHandover(tx, t.errand_id);
      });
      await publish(ctx.deps, t.runner_id, 'tranche.loaded', { errand_id: t.errand_id, tranche_id: trancheId, rung: 'reimbursement' });
      return;
    }

    case 'escalate': {
      await sql.begin(async (tx) => {
        const moved = await tx`UPDATE tranche SET status = 'failed' WHERE id = ${trancheId} AND status = 'pending' RETURNING id`;
        if (moved.length === 0) { log.info('tranche already resolved; not reversing'); return; }
        await tx`UPDATE stall SET status = 'pending' WHERE id = ${t.stall_id}`;
        // Give the money back: the hold reverses, the cap is restored.
        await insertPostingGroup(tx, reverseTranche({
          errandId: t.errand_id, requesterId: t.requester_id, amountCents: cents(t.amount_cents), currency: t.currency,
        }));
        await syncEscrowMirror(tx, t.errand_id, t.requester_id);
        await tx`UPDATE errand SET spent_cents = GREATEST(spent_cents - ${t.amount_cents}, 0), updated_at = now() WHERE id = ${t.errand_id}`;
        await later(tx, 'notify', {
          accountId: t.requester_id, template: `ladder.escalate.${step.reason}`,
          vars: { errandId: t.errand_id, stallId: t.stall_id, amountCents: t.amount_cents },
        });
        await later(tx, 'notify', {
          accountId: t.runner_id, template: 'ladder.escalated_wait', vars: { errandId: t.errand_id, stallId: t.stall_id },
        });
      });
      for (const who of [t.requester_id, t.runner_id]) {
        await publish(ctx.deps, who, 'tranche.failed', { errand_id: t.errand_id, tranche_id: trancheId, reason: step.reason });
      }
      log.warn({ reason: step.reason }, 'tranche escalated to requester');
      return;
    }

    case 'wait':
    case 'done':
      return;
  }

  async function recordFailure(where: { id?: string; idemKey?: string }, code: string, retryable: boolean) {
    await sql.begin(async (tx) => {
      if (where.id) {
        await tx`UPDATE card_attempt SET result = ${retryable ? 'timeout' : 'declined'}, provider_code = ${code}, settled_at = now()
                  WHERE id = ${where.id}`;
      } else {
        await tx`UPDATE card_attempt SET result = ${retryable ? 'timeout' : 'declined'}, provider_code = ${code}, settled_at = now()
                  WHERE tranche_id = ${trancheId} AND idem_key = ${where.idemKey!}`;
      }
      await later(tx, 'card.load', { trancheId }, 1.5);
    });
  }
};

export type { JobContext };
