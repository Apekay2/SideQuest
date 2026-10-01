// packages/domain/src/ledger/posting.ts
// Double entry. A posting group either balances or it does not exist.
// The database enforces this too (deferred constraint trigger); this is the first line.
//
// Sign convention: a positive amount means value now sits in that account. `mpesa_settlement`
// is the platform's boundary with the outside world: money entering the system is a credit
// there (it goes negative), money leaving is a debit. Summed over the whole ledger, every
// currency is zero at all times.
//
// Every group carries its currency (migration 0005 makes the column mandatory and asserts a
// group never mixes currencies), and every posting carries its fund class, so client money
// and platform money are separable from the first row the platform ever writes.

import { type Cents, cents, ZERO } from '../money/money.js';
import type { CurrencyCode } from '../money/currency.js';

export type LedgerAccount =
  | 'user_wallet' | 'escrow_hold' | 'errand_card_float' | 'platform_fee'
  | 'runner_earnings' | 'vendor_paid' | 'reimbursement_due' | 'mpesa_settlement'
  | 'service_fee_requester' | 'maintenance_fee_runner';

export type FundClass = 'client' | 'platform';

/** Revenue accounts hold platform money. Everything else is held on behalf of a user. */
const PLATFORM_ACCOUNTS: ReadonlySet<LedgerAccount> = new Set([
  'platform_fee', 'service_fee_requester', 'maintenance_fee_runner',
]);

export function fundClassOf(account: LedgerAccount): FundClass {
  return PLATFORM_ACCOUNTS.has(account) ? 'platform' : 'client';
}

export interface Posting {
  account: LedgerAccount;
  ownerId: string | null;
  amountCents: Cents; // signed: debit positive, credit negative
  fundClass: FundClass;
}

export interface PostingGroup {
  errandId: string | null;
  reason: string;
  currency: CurrencyCode;
  postings: Posting[];
}

export class UnbalancedGroupError extends Error {
  readonly code = 'LEDGER_UNBALANCED';
  constructor(reason: string, delta: number) {
    super(`Posting group "${reason}" does not balance; delta ${delta} cents`);
    this.name = 'UnbalancedGroupError';
  }
}

export class NegativeAmountError extends Error {
  readonly code = 'LEDGER_NEGATIVE_AMOUNT';
  constructor(reason: string, field: string, value: number) {
    super(`Posting group "${reason}": ${field} must not be negative, got ${value}`);
    this.name = 'NegativeAmountError';
  }
}

function nonNegative(reason: string, fields: Record<string, number>): void {
  for (const [k, v] of Object.entries(fields)) {
    if (v < 0) throw new NegativeAmountError(reason, k, v);
  }
}

function build(errandId: string | null, reason: string, currency: CurrencyCode, raw: Posting[]): PostingGroup {
  // Zero-amount legs carry no information and would trip the duplicate check below when two
  // optional legs are both absent-but-present. Drop them before asserting.
  const postings = raw.filter((p) => p.amountCents !== 0);
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
  return { errandId, reason, currency, postings };
}

const debit = (account: LedgerAccount, ownerId: string | null, amount: number): Posting =>
  ({ account, ownerId, amountCents: cents(amount), fundClass: fundClassOf(account) });

const credit = (account: LedgerAccount, ownerId: string | null, amount: number): Posting =>
  ({ account, ownerId, amountCents: cents(-amount), fundClass: fundClassOf(account) });

// ─────────────────────────────────────────────── money in

/** Requester tops up from M-Pesa. Money enters the system here and nowhere else. */
export function topUp(args: { userId: string; amountCents: Cents; currency: CurrencyCode }): PostingGroup {
  nonNegative('wallet.topup', { amount: args.amountCents });
  return build(null, 'wallet.topup', args.currency, [
    debit('user_wallet', args.userId, args.amountCents),
    credit('mpesa_settlement', null, args.amountCents),
  ]);
}

/**
 * Funding an errand moves the whole deposit from the wallet into escrow: goods cap, the
 * maximum runner fee, the on-time bonus, and the requester's service fee on that maximum.
 * Nothing is recognised as platform revenue yet — a cancellation before assignment refunds
 * all of it (`refundBeforeAssignment`).
 */
export function fundEscrow(args: {
  errandId: string; userId: string; amountCents: Cents; currency: CurrencyCode;
}): PostingGroup {
  nonNegative('escrow.fund', { amount: args.amountCents });
  return build(args.errandId, 'escrow.fund', args.currency, [
    debit('escrow_hold', args.userId, args.amountCents),
    credit('user_wallet', args.userId, args.amountCents),
  ]);
}

/**
 * At assignment the fee is agreed and frozen (errand_fee), and the requester's half is
 * recognised: "charged at deposit" in 06-services.md §6.10, made irrevocable at the moment
 * there is a runner to have earned it.
 */
export function chargeRequesterFee(args: {
  errandId: string; requesterId: string; feeCents: Cents; currency: CurrencyCode;
}): PostingGroup {
  nonNegative('fee.requester', { fee: args.feeCents });
  return build(args.errandId, 'fee.requester', args.currency, [
    debit('service_fee_requester', null, args.feeCents),
    credit('escrow_hold', args.requesterId, args.feeCents),
  ]);
}

// ─────────────────────────────────────────────── spend

/** Requester approves a stall: escrow becomes spendable float on that errand's card. */
export function holdForTranche(args: {
  errandId: string; requesterId: string; amountCents: Cents; currency: CurrencyCode;
}): PostingGroup {
  nonNegative('tranche.hold', { amount: args.amountCents });
  return build(args.errandId, 'tranche.hold', args.currency, [
    debit('errand_card_float', null, args.amountCents),
    credit('escrow_hold', args.requesterId, args.amountCents),
  ]);
}

/** The card load (or till payment) succeeded. Float has left the platform for the vendor. */
export function captureSpend(args: {
  errandId: string; amountCents: Cents; currency: CurrencyCode;
}): PostingGroup {
  nonNegative('tranche.capture', { amount: args.amountCents });
  return build(args.errandId, 'tranche.capture', args.currency, [
    debit('vendor_paid', null, args.amountCents),
    credit('errand_card_float', null, args.amountCents),
  ]);
}

/** Card load failed and the ladder escalated: float returns to escrow, the cap is restored. */
export function reverseTranche(args: {
  errandId: string; requesterId: string; amountCents: Cents; currency: CurrencyCode;
}): PostingGroup {
  nonNegative('tranche.reverse', { amount: args.amountCents });
  return build(args.errandId, 'tranche.reverse', args.currency, [
    debit('escrow_hold', args.requesterId, args.amountCents),
    credit('errand_card_float', null, args.amountCents),
  ]);
}

/**
 * A card is voided with value left on it (an upfront errand that spent less than its cap).
 * The issuer's reported balance returns from the vendor side to escrow, where settlement or
 * a refund picks it up. The amount comes from the issuer, never from arithmetic on our side.
 */
export function returnUnspent(args: {
  errandId: string; requesterId: string; amountCents: Cents; currency: CurrencyCode;
}): PostingGroup {
  nonNegative('card.unspent_return', { amount: args.amountCents });
  return build(args.errandId, 'card.unspent_return', args.currency, [
    debit('escrow_hold', args.requesterId, args.amountCents),
    credit('vendor_paid', null, args.amountCents),
  ]);
}

/**
 * Ladder rung 3: the runner paid cash and is owed it back. The tranche's float becomes a
 * liability to the runner, cleared at settlement. The escrow already moved to float when the
 * stall was approved, so escrow is not touched a second time here.
 */
export function reimbursementDue(args: {
  errandId: string; runnerId: string; amountCents: Cents; currency: CurrencyCode;
}): PostingGroup {
  nonNegative('ladder.reimbursement', { amount: args.amountCents });
  return build(args.errandId, 'ladder.reimbursement', args.currency, [
    debit('reimbursement_due', args.runnerId, args.amountCents),
    credit('errand_card_float', null, args.amountCents),
  ]);
}

// ─────────────────────────────────────────────── close

/**
 * Settlement. What remains in escrow pays the agreed fee and any earned bonus; the runner's
 * maintenance half is deducted from the fee; the reimbursement liability clears into
 * earnings exactly once; whatever is left returns to the requester's wallet.
 *
 * CORRECTED (panel review, finding P-1): the previous version debited escrow for the
 * reimbursement a second time and cancelled its own liability clearance with a duplicate
 * posting. Here escrow is credited only for what it still holds, and `reimbursement_due`
 * appears once.
 */
export function settle(args: {
  errandId: string;
  requesterId: string;
  runnerId: string;
  currency: CurrencyCode;
  /** The escrow balance for this errand at settlement, read from the ledger. */
  escrowBalanceCents: Cents;
  agreedFeeCents: Cents;
  runnerFeeCents: Cents;
  bonusPaidCents: Cents;
  reimbursementCents: Cents;
}): PostingGroup & { refundCents: Cents; runnerTotalCents: Cents } {
  const { errandId, requesterId, runnerId, currency } = args;
  nonNegative('errand.settle', {
    escrow: args.escrowBalanceCents, fee: args.agreedFeeCents, runnerFee: args.runnerFeeCents,
    bonus: args.bonusPaidCents, reimbursement: args.reimbursementCents,
  });
  if (args.runnerFeeCents > args.agreedFeeCents) {
    throw new UnbalancedGroupError('errand.settle (maintenance fee exceeds agreed fee)', args.runnerFeeCents);
  }

  const refund = args.escrowBalanceCents - args.agreedFeeCents - args.bonusPaidCents;
  if (refund < 0) {
    throw new UnbalancedGroupError('errand.settle (escrow cannot cover fee and bonus)', refund);
  }
  const runnerTotal = args.agreedFeeCents - args.runnerFeeCents + args.bonusPaidCents + args.reimbursementCents;

  const group = build(errandId, 'errand.settle', currency, [
    credit('escrow_hold', requesterId, args.escrowBalanceCents),
    credit('reimbursement_due', runnerId, args.reimbursementCents),
    debit('runner_earnings', runnerId, runnerTotal),
    debit('maintenance_fee_runner', null, args.runnerFeeCents),
    debit('user_wallet', requesterId, refund),
  ]);
  return { ...group, refundCents: cents(refund), runnerTotalCents: cents(runnerTotal) };
}

/** Cancelled before a runner was assigned: the whole escrow returns, no fee is kept. */
export function refundEscrow(args: {
  errandId: string; requesterId: string; escrowBalanceCents: Cents; currency: CurrencyCode;
}): PostingGroup {
  nonNegative('escrow.refund', { escrow: args.escrowBalanceCents });
  return build(args.errandId, 'escrow.refund', args.currency, [
    debit('user_wallet', args.requesterId, args.escrowBalanceCents),
    credit('escrow_hold', args.requesterId, args.escrowBalanceCents),
  ]);
}

/**
 * Cancelled after assignment. The runner is paid the cancellation fee in full (it is
 * compensation, not a service the platform takes a cut of); the requester's fee half was
 * already recognised at assignment and stays; the rest of escrow returns.
 */
export function cancelAfterAssignment(args: {
  errandId: string; requesterId: string; runnerId: string; currency: CurrencyCode;
  escrowBalanceCents: Cents; cancellationFeeCents: Cents; reimbursementCents: Cents;
}): PostingGroup {
  nonNegative('errand.cancel', {
    escrow: args.escrowBalanceCents, fee: args.cancellationFeeCents, reimbursement: args.reimbursementCents,
  });
  const refund = args.escrowBalanceCents - args.cancellationFeeCents;
  if (refund < 0) throw new UnbalancedGroupError('errand.cancel (escrow cannot cover fee)', refund);
  return build(args.errandId, 'errand.cancel', args.currency, [
    credit('escrow_hold', args.requesterId, args.escrowBalanceCents),
    credit('reimbursement_due', args.runnerId, args.reimbursementCents),
    debit('runner_earnings', args.runnerId, args.cancellationFeeCents + args.reimbursementCents),
    debit('user_wallet', args.requesterId, refund),
  ]);
}

/** Legal Operations splits a frozen escrow. The only path that does. */
export function rulingSplit(args: {
  errandId: string; requesterId: string; runnerId: string; currency: CurrencyCode;
  escrowBalanceCents: Cents; requesterCents: Cents; runnerCents: Cents;
}): PostingGroup {
  nonNegative('dispute.ruling', { requester: args.requesterCents, runner: args.runnerCents });
  if (args.requesterCents + args.runnerCents !== args.escrowBalanceCents) {
    throw new UnbalancedGroupError(
      'dispute.ruling (split must equal the frozen escrow)',
      args.requesterCents + args.runnerCents - args.escrowBalanceCents,
    );
  }
  return build(args.errandId, 'dispute.ruling', args.currency, [
    credit('escrow_hold', args.requesterId, args.escrowBalanceCents),
    debit('user_wallet', args.requesterId, args.requesterCents),
    debit('runner_earnings', args.runnerId, args.runnerCents),
  ]);
}

// ─────────────────────────────────────────────── money out

/** Runner cashes out to M-Pesa. Money leaves the system here. */
export function payout(args: { runnerId: string; amountCents: Cents; currency: CurrencyCode }): PostingGroup {
  nonNegative('payout.b2c', { amount: args.amountCents });
  return build(null, 'payout.b2c', args.currency, [
    debit('mpesa_settlement', null, args.amountCents),
    credit('runner_earnings', args.runnerId, args.amountCents),
  ]);
}

/** A failed B2C payout: the money comes back to earnings. */
export function payoutReversal(args: { runnerId: string; amountCents: Cents; currency: CurrencyCode }): PostingGroup {
  nonNegative('payout.reversal', { amount: args.amountCents });
  return build(null, 'payout.reversal', args.currency, [
    debit('runner_earnings', args.runnerId, args.amountCents),
    credit('mpesa_settlement', null, args.amountCents),
  ]);
}

/** Requester withdraws unspent wallet balance back to M-Pesa. */
export function withdraw(args: { userId: string; amountCents: Cents; currency: CurrencyCode }): PostingGroup {
  nonNegative('wallet.withdraw', { amount: args.amountCents });
  return build(null, 'wallet.withdraw', args.currency, [
    debit('mpesa_settlement', null, args.amountCents),
    credit('user_wallet', args.userId, args.amountCents),
  ]);
}

/** Sum of a set of postings for one account/owner. Used by tests and reconciliation. */
export function balanceOf(groups: readonly PostingGroup[], account: LedgerAccount, ownerId: string | null): Cents {
  let total = 0;
  for (const g of groups) {
    for (const p of g.postings) {
      if (p.account === account && p.ownerId === ownerId) total += p.amountCents;
    }
  }
  return cents(total);
}

export { ZERO };
