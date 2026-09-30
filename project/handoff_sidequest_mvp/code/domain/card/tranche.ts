// packages/domain/src/card/tranche.ts
// Pure planning for a tranche load. No I/O — the worker performs the effects this returns.

import { type Cents, cents, sub, gt, ZERO } from '../money/money.js';

export class SpendCapExceededError extends Error {
  readonly code = 'SPEND_CAP_EXCEEDED';
  constructor(readonly requested: Cents, readonly remaining: Cents) {
    super(`Stall total ${requested} exceeds remaining cap ${remaining}`);
    this.name = 'SpendCapExceededError';
  }
}

export interface StallSnapshot {
  stallId: string;
  seq: number;
  totalCents: Cents;
  tillNumber: string | null;
  status: 'pending' | 'photographed' | 'approved' | 'declined' | 'substituted' | 'skipped';
}

export interface ErrandSpendSnapshot {
  errandId: string;
  spendCapCents: Cents;
  spentCents: Cents;
}

export interface TranchePlan {
  stallId: string;
  seq: number;
  amountCents: Cents;
  idemKey: string;
  remainingAfterCents: Cents;
  tillNumber: string | null;
}

export function remainingCap(errand: ErrandSpendSnapshot): Cents {
  return sub(errand.spendCapCents, errand.spentCents);
}

/**
 * Deterministic idempotency key. The same (errand, tranche seq, attempt) always produces
 * the same key, so a retried job can never load a card twice.
 */
export function trancheIdemKey(errandId: string, seq: number, attempt: number): string {
  return `tr:${errandId}:${seq}:${attempt}`;
}

/**
 * Validate a requester's approval of one stall and produce the tranche to write.
 * Throws rather than clamping: a requester approving over the cap is a decision they must
 * make explicitly by raising the cap, not something the system quietly truncates.
 */
export function planTranche(errand: ErrandSpendSnapshot, stall: StallSnapshot): TranchePlan {
  if (stall.status !== 'photographed') {
    throw new Error(`Stall ${stall.stallId} is "${stall.status}"; only a photographed stall can be approved`);
  }
  if (!gt(stall.totalCents, ZERO)) {
    throw new Error(`Stall ${stall.stallId} has no priced items`);
  }

  const remaining = remainingCap(errand);
  if (gt(stall.totalCents, remaining)) {
    throw new SpendCapExceededError(stall.totalCents, remaining);
  }

  return {
    stallId: stall.stallId,
    seq: stall.seq,
    amountCents: stall.totalCents,
    idemKey: trancheIdemKey(errand.errandId, stall.seq, 1),
    remainingAfterCents: sub(remaining, stall.totalCents),
    tillNumber: stall.tillNumber,
  };
}

/** True when every stall has reached a settled state and the errand can go to handover. */
export function allStallsResolved(stalls: readonly StallSnapshot[]): boolean {
  return stalls.every((s) => s.status === 'approved' || s.status === 'declined' || s.status === 'skipped');
}

/** What the requester is shown as still committed but not yet spent. */
export function outstandingFloat(stalls: readonly StallSnapshot[]): Cents {
  return stalls
    .filter((s) => s.status === 'approved')
    .reduce<Cents>((acc, s) => cents(acc + s.totalCents), ZERO);
}
