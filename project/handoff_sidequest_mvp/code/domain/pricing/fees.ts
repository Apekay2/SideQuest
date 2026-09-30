// packages/domain/src/pricing/fees.ts
// Two-sided fee. Total take is 12% of the RUNNER'S FEE — not of the goods. The platform
// does not take a percentage of somebody's groceries.
//
//   requester pays   F + half   at deposit
//   runner receives  F - half   at disbursement
//   platform keeps   F * rate
//
// Both halves are computed ONCE and stored (errand_fee). Never re-derive a fee from a
// percentage at display time: the rate changes, history must not.

import { type Cents, cents, add, sub, ZERO } from '../money/money.js';

export const DEFAULT_RATE_BPS = 1200; // 12%

export interface FeeSplit {
  baseCents: Cents;          // the agreed runner fee, F
  rateBps: number;
  requesterFeeCents: Cents;  // charged on top at deposit
  runnerFeeCents: Cents;     // deducted at disbursement
  totalTakeCents: Cents;
}

/** Banker's rounding, so a long run of .5 cases does not drift the platform's way. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function splitFee(baseCents: Cents, rateBps: number = DEFAULT_RATE_BPS): FeeSplit {
  if (rateBps < 0 || rateBps > 3000) throw new Error(`Implausible fee rate ${rateBps} bps`);

  const total = roundHalfEven((baseCents * rateBps) / 10_000);
  // Split evenly; an odd cent goes to the requester's half, which is charged on top rather
  // than deducted — the runner never loses a cent to rounding.
  const runnerHalf = Math.trunc(total / 2);
  const requesterHalf = total - runnerHalf;

  return {
    baseCents,
    rateBps,
    requesterFeeCents: cents(requesterHalf),
    runnerFeeCents: cents(runnerHalf),
    totalTakeCents: cents(total),
  };
}

/** What the requester is asked to deposit. Goods are passed through at cost. */
export function depositTotal(args: {
  agreedFeeCents: Cents;
  goodsCapCents: Cents;
  bonusCents: Cents;
  rateBps?: number;
}): { split: FeeSplit; depositCents: Cents } {
  const split = splitFee(args.agreedFeeCents, args.rateBps);
  const depositCents = cents(
    args.agreedFeeCents + args.goodsCapCents + args.bonusCents + split.requesterFeeCents,
  );
  return { split, depositCents };
}

/**
 * What the runner actually receives. Bonus and reimbursement are NOT fee-bearing:
 * an on-time bonus is paid in full, and taking a cut of money the runner already spent
 * out of pocket would be indefensible.
 */
export function disbursementTotal(args: {
  agreedFeeCents: Cents;
  bonusCents: Cents;
  reimbursementCents: Cents;
  rateBps?: number;
}): { split: FeeSplit; payoutCents: Cents } {
  const split = splitFee(args.agreedFeeCents, args.rateBps);
  const payoutCents = cents(
    args.agreedFeeCents - split.runnerFeeCents + args.bonusCents + args.reimbursementCents,
  );
  if (payoutCents < 0) throw new Error('Disbursement resolved negative; fee exceeds the agreed fee');
  return { split, payoutCents };
}

/**
 * Refund before assignment. The requester's half is returned; the runner's half was never
 * charged, because nobody had been assigned to charge it to.
 */
export function refundBeforeAssignment(args: {
  depositCents: Cents;
  split: FeeSplit;
}): { refundCents: Cents; platformKeepsCents: Cents } {
  return { refundCents: args.depositCents, platformKeepsCents: ZERO };
}

/**
 * Cancellation after assignment. The runner keeps a cancellation fee; the platform keeps
 * only the requester's half, because no disbursement happened to deduct the other from.
 */
export function refundAfterAssignment(args: {
  depositCents: Cents;
  split: FeeSplit;
  cancellationFeeCents: Cents;
}): { refundCents: Cents; runnerCents: Cents; platformKeepsCents: Cents } {
  const refund = sub(args.depositCents, add(args.cancellationFeeCents, args.split.requesterFeeCents));
  if (refund < 0) throw new Error('Cancellation arithmetic resolved negative');
  return {
    refundCents: cents(refund),
    runnerCents: args.cancellationFeeCents,
    platformKeepsCents: args.split.requesterFeeCents,
  };
}

/** Display breakdown for the deposit prompt. Every line is shown; nothing is folded in. */
export function depositBreakdown(args: {
  agreedFeeCents: Cents;
  goodsCapCents: Cents;
  bonusCents: Cents;
  rateBps?: number;
}): Array<{ key: string; amountCents: Cents }> {
  const { split, depositCents } = depositTotal(args);
  const lines: Array<{ key: string; amountCents: Cents }> = [
    { key: 'fee.runner', amountCents: args.agreedFeeCents },
  ];
  if (args.goodsCapCents > ZERO) lines.push({ key: 'fee.goods_cap', amountCents: args.goodsCapCents });
  if (args.bonusCents > ZERO) lines.push({ key: 'fee.bonus', amountCents: args.bonusCents });
  lines.push({ key: 'fee.service', amountCents: split.requesterFeeCents });
  lines.push({ key: 'fee.total', amountCents: depositCents });
  return lines;
}
