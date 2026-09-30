// apps/worker/src/jobs/card-load.job.ts
// Executes one rung of the ladder per run, then either finishes or re-enqueues itself.
// One rung per job means every rung is independently retryable and independently traced.

import type { Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { tranche, cardAttempt, card, errand, stall } from '@sidequest/db/schema';
import { insertPostingGroup, enqueueOutbox } from '@sidequest/db/repositories';
import { nextStep, type Attempt } from '@sidequest/domain/card/decline-ladder';
import { captureSpend, reverseTranche, reimbursementDue } from '@sidequest/domain/ledger/posting';
import { cents } from '@sidequest/domain/money/money';
import type { IssuerPort } from '@sidequest/domain/card/issuer.port';
import type { DarajaB2C } from '@sidequest/adapters/daraja/b2c';
import type { Db } from '@sidequest/db';
import { logger } from '@sidequest/observability';

const CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;

export interface CardLoadPayload { trancheId: string }

export function makeCardLoadJob(deps: { db: Db; issuer: IssuerPort; b2c: DarajaB2C }) {
  const { db, issuer, b2c } = deps;

  return async function cardLoad(job: Job<CardLoadPayload>): Promise<void> {
    const { trancheId } = job.data;
    const log = logger.child({ job: 'card.load', trancheId, attempt: job.attemptsMade });

    const ctx = await db.query.tranche.findFirst({
      where: eq(tranche.id, trancheId),
      with: { card: { with: { errand: true } }, stall: true, attempts: true },
    });
    if (!ctx) { log.error('tranche vanished'); return; }
    if (ctx.status === 'loaded' || ctx.status === 'reversed') { log.info('already resolved'); return; }

    const e = ctx.card.errand;
    if (!e.runnerId) { log.error('errand has no runner; ladder cannot run'); return; }
    const attempts: Attempt[] = ctx.attempts.map((a) => ({ rung: a.rung, result: a.result, code: a.providerCode }));

    const requestedAt = ctx.attempts.find((a) => a.rung === 'reimbursement')?.createdAt;
    const step = nextStep({
      attempts,
      amountCents: cents(ctx.amountCents),
      remainingCapCents: cents(e.spendCapCents - e.spentCents + ctx.amountCents),
      tillNumber: ctx.stall.tillNumber,
      reimbursementConfirmed: ctx.reimbursementConfirmed ?? null,
      confirmationWindowExpired:
        requestedAt !== undefined && Date.now() - requestedAt.getTime() > CONFIRMATION_WINDOW_MS,
    });

    log.info({ step: step.action }, 'ladder step');

    switch (step.action) {
      case 'load_card': {
        const idemKey = `${ctx.idemKey}:${step.rung}`;
        const [attempt] = await db.insert(cardAttempt)
          .values({ trancheId, rung: step.rung, idemKey, result: 'pending' })
          .onConflictDoNothing({ target: cardAttempt.idemKey })
          .returning();

        // A pending attempt row that already exists means a previous run got as far as
        // calling the issuer and then died. Returning here (the old behaviour) left a card
        // that may hold real money with a tranche stuck at `pending`: the runner is never
        // told the card is ready, the ledger never records the capture, and the nightly
        // reconciliation reports an issuer/ledger divergence a human has to unpick.
        // Ask the issuer what happened, by the same idempotency key, and finish the job.
        if (!attempt) {
          const existing = await db.query.cardAttempt.findFirst({
            where: and(eq(cardAttempt.trancheId, trancheId), eq(cardAttempt.idemKey, idemKey)),
          });
          if (existing && existing.result !== 'pending') { log.info('attempt already resolved'); return; }
          log.warn('replaying an interrupted issuer call; reconciling by idempotency key');
          const prior = await issuer.getLoad({ issuerRef: ctx.card.issuerRef, idemKey });
          if (prior.status === 'unknown') {
            // Never assume. Re-enqueue with backoff and let the reconciliation job page if
            // it is still unknown at the nightly run.
            await job.queue.add('card.load', { trancheId },
              { jobId: `card.load:${trancheId}:replay:${job.attemptsMade}`, delay: 5000 });
            return;
          }
          await recordLoadOutcome(prior.status === 'succeeded'
            ? { ok: true, providerRef: prior.providerRef }
            : { ok: false, retryable: false, code: prior.code });
          return;
        }

        const res = await issuer.loadCard({
          issuerRef: ctx.card.issuerRef,
          amountCents: cents(ctx.amountCents),
          idemKey,
        });
        await recordLoadOutcome(res, attempt.id);
        return;

        // One writer for the outcome, whether it came from the live call or the replay
        // reconciliation, so the two paths cannot drift.
        async function recordLoadOutcome(
          res: { ok: true; providerRef: string } | { ok: false; retryable: boolean; code?: string },
          attemptId?: string,
        ) {
          const where = attemptId
            ? eq(cardAttempt.id, attemptId)
            : and(eq(cardAttempt.trancheId, trancheId), eq(cardAttempt.idemKey, idemKey));

          if (res.ok) {
            await db.transaction(async (tx) => {
              await tx.update(cardAttempt)
                .set({ result: 'success', providerRef: res.providerRef, settledAt: new Date() })
                .where(where);
              // Guarded so a replay cannot capture the same spend twice.
              const moved = await tx.update(tranche).set({ status: 'loaded' })
                .where(and(eq(tranche.id, trancheId), eq(tranche.status, 'pending')))
                .returning();
              if (moved.length === 0) { log.info('tranche already loaded; not re-capturing'); return; }
              await tx.update(card)
                .set({ loadedCents: sql`${card.loadedCents} + ${ctx.amountCents}` })
                .where(eq(card.id, ctx.cardId));
              await insertPostingGroup(tx, captureSpend(e.id, cents(ctx.amountCents)));
              await enqueueOutbox(tx, 'notify', {
                accountId: e.runnerId, template: 'card.ready',
                vars: { errandId: e.id, stallId: ctx.stallId, amountCents: ctx.amountCents },
              });
            });
            return;
          }

          await db.update(cardAttempt)
            .set({ result: res.retryable ? 'timeout' : 'declined', providerCode: res.code, settledAt: new Date() })
            .where(where);
          // jobId makes the re-enqueue idempotent: without one, a webhook and a timer could
          // both wake the ladder and run the next rung twice.
          await job.queue.add('card.load', { trancheId },
            { jobId: `card.load:${trancheId}:${step.rung}:next`, delay: 1500 });
        }
      }

      case 'pay_till': {
        const idemKey = `${ctx.idemKey}:till`;
        const [attempt] = await db.insert(cardAttempt)
          .values({ trancheId, rung: 'mpesa_till', idemKey, result: 'pending' })
          .onConflictDoNothing({ target: cardAttempt.idemKey })
          .returning();
        if (!attempt) return;

        // Result arrives on the Daraja webhook, which re-enqueues this job.
        const { conversationId } = await b2c.payTill({
          tillNumber: step.tillNumber,
          amountCents: step.amountCents,
          reference: `SQ-${e.id.slice(0, 8)}-${ctx.seq}`,
          idemKey,
        });
        await db.update(cardAttempt)
          .set({ providerRef: conversationId })
          .where(eq(cardAttempt.id, attempt.id));
        return;
      }

      case 'request_reimbursement': {
        const idemKey = `${ctx.idemKey}:reimb`;
        await db.transaction(async (tx) => {
          await tx.insert(cardAttempt)
            .values({ trancheId, rung: 'reimbursement', idemKey, result: 'pending' })
            .onConflictDoNothing({ target: cardAttempt.idemKey });
          await enqueueOutbox(tx, 'notify', {
            accountId: e.requesterId, template: 'ladder.reimbursement_requested',
            vars: { errandId: e.id, trancheId, amountCents: step.amountCents },
          });
        });
        // Wake up when the window closes, whether or not the requester answered.
        await job.queue.add('card.load', { trancheId },
          { jobId: `card.load:${trancheId}:reimb:window`, delay: CONFIRMATION_WINDOW_MS + 1000 });
        return;
      }

      case 'pay_reimbursement': {
        await db.transaction(async (tx) => {
          // WAS: `.where(eq(a.trancheId, id) && eq(a.rung, 'reimbursement'))`. JavaScript `&&`
          // on two SQL predicate objects evaluates to the SECOND one, so this UPDATE ran as
          // `WHERE rung = 'reimbursement'` across the WHOLE TABLE — marking every pending
          // reimbursement attempt on every errand in the system as a success, on any single
          // cash reimbursement. The most expensive character in the codebase.
          await tx.update(cardAttempt)
            .set({ result: 'success', settledAt: new Date() })
            .where(and(eq(cardAttempt.trancheId, trancheId), eq(cardAttempt.rung, 'reimbursement')));
          const moved = await tx.update(tranche).set({ status: 'loaded' })
            .where(and(eq(tranche.id, trancheId), eq(tranche.status, 'pending')))
            .returning();
          if (moved.length === 0) return;
          await insertPostingGroup(tx, reimbursementDue(e.id, e.requesterId, e.runnerId!, cents(step.amountCents)));
          await enqueueOutbox(tx, 'notify', {
            accountId: e.runnerId, template: 'ladder.pay_cash',
            vars: { errandId: e.id, stallId: ctx.stallId, amountCents: step.amountCents },
          });
        });
        return;
      }

      case 'escalate': {
        await db.transaction(async (tx) => {
          const moved = await tx.update(tranche).set({ status: 'failed' })
            .where(and(eq(tranche.id, trancheId), eq(tranche.status, 'pending')))
            .returning();
          if (moved.length === 0) { log.info('tranche already resolved; not reversing'); return; }
          await tx.update(stall).set({ status: 'pending' }).where(eq(stall.id, ctx.stallId));
          // Give the money back: the hold reverses, the cap is restored.
          await insertPostingGroup(tx, reverseTranche(e.id, e.requesterId, cents(ctx.amountCents)));
          await tx.update(errand)
            .set({ spentCents: sql`GREATEST(${errand.spentCents} - ${ctx.amountCents}, 0)` })
            .where(eq(errand.id, e.id));
          await enqueueOutbox(tx, 'notify', {
            accountId: e.requesterId, template: `ladder.escalate.${step.reason}`,
            vars: { errandId: e.id, stallId: ctx.stallId, amountCents: ctx.amountCents },
          });
          await enqueueOutbox(tx, 'notify', {
            accountId: e.runnerId, template: 'ladder.escalated_wait',
            vars: { errandId: e.id, stallId: ctx.stallId },
          });
        });
        log.warn({ reason: step.reason }, 'tranche escalated to requester');
        return;
      }

      case 'wait':
      case 'done':
        return;
    }
  };
}
