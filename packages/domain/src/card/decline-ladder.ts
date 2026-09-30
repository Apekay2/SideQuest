// packages/domain/src/card/decline-ladder.ts
// Three rungs, tried in order, each with a hard stop. Pure decision logic: given what has
// been attempted so far, say what to do next. The worker performs it.

import type { Cents } from '../money/money.js';
import { min } from '../money/money.js';

export type Rung = 'card' | 'card_retry' | 'mpesa_till' | 'reimbursement';
export type AttemptResult = 'pending' | 'success' | 'declined' | 'error' | 'timeout';

export interface Attempt {
  rung: Rung;
  result: AttemptResult;
  code: string | null;
}

export interface LadderContext {
  attempts: readonly Attempt[];
  amountCents: Cents;
  remainingCapCents: Cents;
  tillNumber: string | null;
  /** Requester confirmed they will settle a cash payment. Null while we are still waiting. */
  reimbursementConfirmed: boolean | null;
  /** Set by the worker when the 5-minute confirmation window has passed. */
  confirmationWindowExpired: boolean;
}

export type LadderStep =
  | { action: 'load_card'; rung: 'card' | 'card_retry'; attempt: number }
  | { action: 'pay_till'; tillNumber: string; amountCents: Cents }
  | { action: 'request_reimbursement'; amountCents: Cents }
  | { action: 'pay_reimbursement'; amountCents: Cents }
  | { action: 'wait'; reason: 'awaiting_confirmation' }
  | { action: 'escalate'; reason: 'no_rung_left' | 'confirmation_timeout' | 'cap_exhausted' }
  | { action: 'done' };

const succeeded = (a: Attempt) => a.result === 'success';
const failed = (a: Attempt) => a.result === 'declined' || a.result === 'error' || a.result === 'timeout';

/**
 * The whole ladder in one function. Read top to bottom; the order of these checks IS the
 * business rule, so do not reorder them without changing the spec.
 */
export function nextStep(ctx: LadderContext): LadderStep {
  const { attempts, amountCents, remainingCapCents, tillNumber } = ctx;

  if (attempts.some(succeeded)) return { action: 'done' };
  if (attempts.some((a) => a.result === 'pending')) return { action: 'wait', reason: 'awaiting_confirmation' };

  const cardTries = attempts.filter((a) => a.rung === 'card' || a.rung === 'card_retry');

  // Rung 1 — first card load.
  if (cardTries.length === 0) return { action: 'load_card', rung: 'card', attempt: 1 };

  // Rung 1b — exactly one retry, and only for a retryable failure.
  if (cardTries.length === 1 && failed(cardTries[0]!) && isRetryable(cardTries[0]!.code)) {
    return { action: 'load_card', rung: 'card_retry', attempt: 2 };
  }

  // Rung 2 — vendor till, from the errand's own held balance. Skipped when no till exists.
  const tillTry = attempts.find((a) => a.rung === 'mpesa_till');
  if (!tillTry && tillNumber) {
    return { action: 'pay_till', tillNumber, amountCents };
  }

  // Rung 3 — runner pays cash, requester settles from escrow. Capped, and never silent.
  const capped = min(amountCents, remainingCapCents);
  if (capped <= 0) return { action: 'escalate', reason: 'cap_exhausted' };

  if (ctx.reimbursementConfirmed === true) {
    return { action: 'pay_reimbursement', amountCents: capped };
  }
  if (ctx.reimbursementConfirmed === false) {
    return { action: 'escalate', reason: 'no_rung_left' };
  }
  if (ctx.confirmationWindowExpired) {
    return { action: 'escalate', reason: 'confirmation_timeout' };
  }
  if (!attempts.some((a) => a.rung === 'reimbursement')) {
    return { action: 'request_reimbursement', amountCents: capped };
  }
  return { action: 'wait', reason: 'awaiting_confirmation' };
}

const RETRYABLE = new Set([
  'issuer_timeout', 'rate_limited', 'temporary_failure', 'network_error', 'service_unavailable',
]);

function isRetryable(code: string | null): boolean {
  return code !== null && RETRYABLE.has(code);
}

/** Copy shown to the requester for each escalation reason. Keys into i18n, not literals. */
export const ESCALATION_COPY: Record<string, string> = {
  no_rung_left: 'ladder.escalate.no_rung_left',
  confirmation_timeout: 'ladder.escalate.confirmation_timeout',
  cap_exhausted: 'ladder.escalate.cap_exhausted',
};
