// packages/domain/src/ledger/posting.ts
// Double entry. A posting group either balances or it does not exist.
// The database enforces this too (deferred constraint trigger); this is the first line.

import { type Cents, cents, ZERO } from '../money/money.js';

export type LedgerAccount =
  | 'user_wallet' | 'escrow_hold' | 'errand_card_float' | 'platform_fee'
  | 'runner_earnings' | 'vendor_paid' | 'reimbursement_due' | 'mpesa_settlement';

export interface Posting {
  account: LedgerAccount;
  ownerId: string | null;
  amountCents: Cents; // signed: debit positive, credit negative
}

export interface PostingGroup {
  errandId: string | null;
  reason: string;
  postings: Posting[];
}

export class UnbalancedGroupError extends Error {
  readonly code = 'LEDGER_UNBALANCED';
  constructor(reason: string, delta: number) {
    super(`Posting group "${reason}" does not balance; delta ${delta} cents`);
    this.name = 'UnbalancedGroupError';
  }
}

function build(errandId: string | null, reason: string, postings: Posting[]): PostingGroup {
  const delta = postings.reduce((acc, p) => acc + p.amountCents, 0);
  if (delta !== 0) throw new UnbalancedGroupError(reason, delta);
  if (postings.length < 2) throw new UnbalancedGroupError(reason, delta);
  // A group that names the same account twice is almost always two postings that cancel by
  // accident (see finding P-1). Legitimate same-account pairs do not occur in this ledger,
  // so this is an assertion rather than a policy.
  const seen = new Set<string>();
  for (const p of postings) {
    const key = `${p.account}:${p.ownerId ?? ''}`;
    if (seen.has(key)) throw new UnbalancedGroupError(`${reason} (duplicate account ${key})`, delta);
    seen.add(key);
  }
  return { errandId, reason, postings };
}

const debit = (account: LedgerAccount, ownerId: string | null, amount: Cents): Posting =>
  ({ account, ownerId, amountCents: amount });

const credit = (account: LedgerAccount, ownerId: string | null, amount: Cents): Posting =>
  ({ account, ownerId, amountCents: cents(-amount) });

/** Requester tops up from M-Pesa. Money enters the system here and nowhere else. */
export function topUp(userId: string, amount: Cents): PostingGroup {
  return build(null, 'wallet.topup', [
    debit('user_wallet', userId, amount),
    credit('mpesa_settlement', null, amount),
  ]);
}

/** Publishing an errand moves cap + max fee from the wallet into escrow. */
export function fundEscrow(errandId: string, userId: string, amount: Cents): PostingGroup {
  return build(errandId, 'escrow.fund', [
    debit('escrow_hold', userId, amount),
    credit('user_wallet', userId, amount),
  ]);
}

/** Requester approves a stall: escrow becomes spendable float on that errand's card. */
export function holdForTranche(errandId: string, userId: string, amount: Cents): PostingGroup {
  return build(errandId, 'tranche.hold', [
    debit('errand_card_float', null, amount),
    credit('escrow_hold', userId, amount),
  ]);
}

/** The card (or till) actually paid the vendor. Float becomes spent. */
export function captureSpend(errandId: string, amount: Cents): PostingGroup {
  return build(errandId, 'tranche.capture', [
    debit('vendor_paid', null, amount),
    credit('errand_card_float', null, amount),
  ]);
}

/** Card load failed or the tranche was reversed: float returns to escrow. */
export function reverseTranche(errandId: string, userId: string, amount: Cents): PostingGroup {
  return build(errandId, 'tranche.reverse', [
    debit('escrow_hold', userId, amount),
    credit('errand_card_float', null, amount),
  ]);
}

/** Ladder rung 3: the runner paid cash and is owed it back out of escrow. */
export function reimbursementDue(errandId: string, requesterId: string, runnerId: string, amount: Cents): PostingGroup {
  return build(errandId, 'ladder.reimbursement', [
    debit('reimbursement_due', runnerId, amount),
    credit('escrow_hold', requesterId, amount),
  ]);
}

/**
 * Settlement. Escrow releases the runner's fee and any bonus, the platform takes its cut,
 * the reimbursement liability incurred earlier is cleared, and whatever remains of the cap
 * returns to the wallet.
 *
 * CORRECTED (panel review, finding P-1). The previous version computed
 *   escrowOut = fee + bonus + reimbursement + refund
 * and then pushed BOTH a credit and a debit of `reimbursement_due` for the same amount.
 * The two cancelled, so:
 *   - escrow was debited for the reimbursement TWICE — once when it was incurred by
 *     `reimbursementDue()`, once again here — overdrawing the requester's escrow by the
 *     reimbursed amount on every cash-ladder errand;
 *   - the `reimbursement_due` liability never cleared, so it accumulated forever.
 * The group still summed to zero, so both the deferred trigger and the nightly
 * "sum(posting) = 0" reconciliation passed. A balanced ledger is not a correct one; the
 * per-account assertions below are what catch this class, and §5 of 10-panel-review.md adds
 * them to the nightly job.
 */
export function settle(args: {
  errandId: string;
  requesterId: string;
  runnerId: string;
  feeCents: Cents;
  bonusCents: Cents;
  reimbursementCents: Cents;
  platformFeeCents: Cents;
  refundCents: Cents;
}): PostingGroup {
  const {
    errandId, requesterId, runnerId,
    feeCents, bonusCents, reimbursementCents, platformFeeCents, refundCents,
  } = args;

  const runnerTotal = cents(feeCents + bonusCents + reimbursementCents - platformFeeCents);
  if (runnerTotal < 0) throw new UnbalancedGroupError('errand.settle', runnerTotal);

  // The reimbursement already left escrow when it was incurred. Escrow owes only the fee,
  // the bonus and the refund now.
  const escrowOut = cents(feeCents + bonusCents + refundCents);

  const postings: Posting[] = [
    credit('escrow_hold', requesterId, escrowOut),
    debit('runner_earnings', runnerId, runnerTotal),
  ];
  if (platformFeeCents > ZERO) postings.push(debit('platform_fee', null, platformFeeCents));
  // Clear the liability exactly once: the runner is paid it inside runnerTotal.
  if (reimbursementCents > ZERO) postings.push(credit('reimbursement_due', runnerId, reimbursementCents));
  if (refundCents > ZERO) postings.push(debit('user_wallet', requesterId, refundCents));

  return build(errandId, 'errand.settle', postings);
}

/** Legal Operations splits a frozen escrow. The only path that does. */
export function rulingSplit(args: {
  errandId: string;
  requesterId: string;
  runnerId: string;
  requesterCents: Cents;
  runnerCents: Cents;
}): PostingGroup {
  const { errandId, requesterId, runnerId, requesterCents, runnerCents } = args;
  return build(errandId, 'dispute.ruling', [
    credit('escrow_hold', requesterId, cents(requesterCents + runnerCents)),
    debit('user_wallet', requesterId, requesterCents),
    debit('runner_earnings', runnerId, runnerCents),
  ]);
}

/** Runner cashes out to M-Pesa. Money leaves the system here and nowhere else. */
export function payout(runnerId: string, amount: Cents): PostingGroup {
  return build(null, 'payout.b2c', [
    debit('mpesa_settlement', null, amount),
    credit('runner_earnings', runnerId, amount),
  ]);
}
