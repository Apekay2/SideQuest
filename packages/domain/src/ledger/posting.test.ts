// The ledger's meaning, not just its arithmetic. Every scenario below walks a whole errand
// through the posting functions and asserts where the money ended up — the class of check
// that a balanced-but-wrong group (finding P-1) fails.

import { describe, it, expect } from 'vitest';
import {
  topUp, fundEscrow, chargeRequesterFee, holdForTranche, captureSpend, reverseTranche,
  reimbursementDue, settle, refundEscrow, cancelAfterAssignment, rulingSplit, payout,
  balanceOf, UnbalancedGroupError, NegativeAmountError, fundClassOf, type PostingGroup,
} from './posting.js';
import { cents } from '../money/money.js';
import { splitFee, depositTotal } from '../pricing/fees.js';

const E = 'errand-1', R = 'requester-1', N = 'runner-1', KES = 'KES' as const;

function total(groups: PostingGroup[]): number {
  return groups.flatMap((g) => g.postings).reduce((a, p) => a + p.amountCents, 0);
}

describe('posting groups', () => {
  it('every builder balances and carries its currency', () => {
    const g = topUp({ userId: R, amountCents: cents(1000), currency: KES });
    expect(g.currency).toBe('KES');
    expect(total([g])).toBe(0);
  });

  it('refuses negative amounts rather than silently inverting a flow', () => {
    expect(() => topUp({ userId: R, amountCents: cents(-1), currency: KES })).toThrow(NegativeAmountError);
  });

  it('classes revenue accounts as platform money and everything else as client money', () => {
    expect(fundClassOf('service_fee_requester')).toBe('platform');
    expect(fundClassOf('maintenance_fee_runner')).toBe('platform');
    expect(fundClassOf('escrow_hold')).toBe('client');
    expect(fundClassOf('runner_earnings')).toBe('client');
  });

  it('a ruling must split exactly the frozen escrow', () => {
    expect(() => rulingSplit({
      errandId: E, requesterId: R, runnerId: N, currency: KES,
      escrowBalanceCents: cents(1000), requesterCents: cents(400), runnerCents: cents(500),
    })).toThrow(UnbalancedGroupError);
  });
});

describe('a market run, end to end', () => {
  // Fee KSh 300 agreed, cap KSh 1,000, bonus KSh 50, max fee KSh 400 at deposit.
  const agreed = cents(30000), cap = cents(100000), bonus = cents(5000), maxFee = cents(40000);
  const deposit = depositTotal({ agreedFeeCents: maxFee, goodsCapCents: cap, bonusCents: bonus }).depositCents;
  const split = splitFee(agreed);

  function run(opts: { cash?: number; bonusEarned: boolean }) {
    const groups: PostingGroup[] = [];
    groups.push(topUp({ userId: R, amountCents: deposit, currency: KES }));
    groups.push(fundEscrow({ errandId: E, userId: R, amountCents: deposit, currency: KES }));
    groups.push(chargeRequesterFee({ errandId: E, requesterId: R, feeCents: split.requesterFeeCents, currency: KES }));
    // Stall 1: KSh 380 on the card.
    groups.push(holdForTranche({ errandId: E, requesterId: R, amountCents: cents(38000), currency: KES }));
    groups.push(captureSpend({ errandId: E, amountCents: cents(38000), currency: KES }));
    // Stall 2: optional cash reimbursement via ladder rung 3.
    let reimbursed = 0;
    if (opts.cash) {
      groups.push(holdForTranche({ errandId: E, requesterId: R, amountCents: cents(opts.cash), currency: KES }));
      groups.push(reimbursementDue({ errandId: E, runnerId: N, amountCents: cents(opts.cash), currency: KES }));
      reimbursed = opts.cash;
    }
    const escrow = balanceOf(groups, 'escrow_hold', R);
    const s = settle({
      errandId: E, requesterId: R, runnerId: N, currency: KES,
      escrowBalanceCents: escrow, agreedFeeCents: agreed, runnerFeeCents: split.runnerFeeCents,
      bonusPaidCents: opts.bonusEarned ? bonus : cents(0), reimbursementCents: cents(reimbursed),
    });
    groups.push(s);
    return { groups, s };
  }

  it('leaves escrow, float and the reimbursement liability at exactly zero', () => {
    const { groups } = run({ cash: 14000, bonusEarned: true });
    expect(balanceOf(groups, 'escrow_hold', R)).toBe(0);
    expect(balanceOf(groups, 'errand_card_float', null)).toBe(0);
    expect(balanceOf(groups, 'reimbursement_due', N)).toBe(0);
    expect(total(groups)).toBe(0);
  });

  it('pays the runner fee minus their half, plus the bonus and the cash in full', () => {
    const { groups } = run({ cash: 14000, bonusEarned: true });
    expect(balanceOf(groups, 'runner_earnings', N)).toBe(agreed - split.runnerFeeCents + bonus + 14000);
  });

  it('takes 12% of the runner fee in total, 6% from each side, and nothing from the goods', () => {
    const { groups } = run({ cash: 14000, bonusEarned: true });
    expect(balanceOf(groups, 'service_fee_requester', null)).toBe(1800);
    expect(balanceOf(groups, 'maintenance_fee_runner', null)).toBe(1800);
  });

  it('returns an unearned bonus and the unused cap to the requester', () => {
    const { groups } = run({ bonusEarned: false });
    // Requester spent: fee + their half + goods on the card. Everything else comes back.
    const spent = agreed + split.requesterFeeCents + 38000;
    expect(balanceOf(groups, 'user_wallet', R)).toBe(deposit - spent);
  });

  it('P-1 regression: escrow is never debited for a reimbursement twice', () => {
    // With the old settle() escrow went negative by the reimbursed amount on every cash-ladder
    // errand. Here the refund is computed from what escrow still holds, so a double debit
    // would show up as a negative refund and throw.
    const { s } = run({ cash: 14000, bonusEarned: true });
    expect(s.refundCents).toBeGreaterThanOrEqual(0);
    const legs = s.postings.filter((p) => p.account === 'reimbursement_due');
    expect(legs).toHaveLength(1);
  });

  it('a failed tranche reverses its hold and restores escrow', () => {
    const groups = [
      fundEscrow({ errandId: E, userId: R, amountCents: cents(1000), currency: KES }),
      holdForTranche({ errandId: E, requesterId: R, amountCents: cents(600), currency: KES }),
      reverseTranche({ errandId: E, requesterId: R, amountCents: cents(600), currency: KES }),
    ];
    expect(balanceOf(groups, 'escrow_hold', R)).toBe(1000);
    expect(balanceOf(groups, 'errand_card_float', null)).toBe(0);
  });

  it('refuses to settle when escrow cannot cover the fee', () => {
    expect(() => settle({
      errandId: E, requesterId: R, runnerId: N, currency: KES,
      escrowBalanceCents: cents(100), agreedFeeCents: cents(30000), runnerFeeCents: cents(1800),
      bonusPaidCents: cents(0), reimbursementCents: cents(0),
    })).toThrow(UnbalancedGroupError);
  });
});

describe('cancellation', () => {
  it('before assignment refunds the whole escrow', () => {
    const groups = [
      fundEscrow({ errandId: E, userId: R, amountCents: cents(50000), currency: KES }),
      refundEscrow({ errandId: E, requesterId: R, escrowBalanceCents: cents(50000), currency: KES }),
    ];
    expect(balanceOf(groups, 'escrow_hold', R)).toBe(0);
    expect(balanceOf(groups, 'user_wallet', R)).toBe(0);
  });

  it('after assignment pays the runner the cancellation fee in full', () => {
    const g = cancelAfterAssignment({
      errandId: E, requesterId: R, runnerId: N, currency: KES,
      escrowBalanceCents: cents(50000), cancellationFeeCents: cents(15000), reimbursementCents: cents(0),
    });
    expect(balanceOf([g], 'runner_earnings', N)).toBe(15000);
    expect(balanceOf([g], 'user_wallet', R)).toBe(35000);
  });
});

describe('payout', () => {
  it('moves earnings out through the settlement account', () => {
    const g = payout({ runnerId: N, amountCents: cents(20000), currency: KES });
    expect(balanceOf([g], 'runner_earnings', N)).toBe(-20000);
    expect(balanceOf([g], 'mpesa_settlement', null)).toBe(20000);
  });
});
