// Specification tests for the smaller pure modules: fees, money, the state machine, text
// sanitising, the link handshake and the ETA engine.

import { describe, it, expect } from 'vitest';
import { splitFee, depositTotal, disbursementTotal, refundAfterAssignment } from './pricing/fees.js';
import { cents, money, addM, format, formatKes, split, MoneyError } from './money/money.js';
import { assertSupported, CurrencyError, assertMarketsConsistent } from './money/currency.js';
import { nextStatus, canTransition, IllegalTransitionError } from './errand/machine.js';
import { cleanMsisdn, cleanName, cleanProse, csvCell, kycObjectKey, InvalidTextError } from './text/sanitize.js';
import {
  generateDeviceKeys, rawPublicKey, deriveSecret, linkHash, tagFix, verifyFix, presence,
} from './errand/link-handshake.js';
import { computeEta, percentComplete, shouldShowExactTime, bonusEarned, type Checkpoint } from './progress/eta.js';
import { entitlementsFor, minimumTierFor } from './kyc/entitlements.js';
import { planTranche, SpendCapExceededError } from './card/tranche.js';

describe('fees', () => {
  it('takes 12% of the runner fee, split evenly', () => {
    const s = splitFee(cents(30000));
    expect(s.totalTakeCents).toBe(3600);
    expect(s.requesterFeeCents).toBe(1800);
    expect(s.runnerFeeCents).toBe(1800);
  });

  it('gives an odd cent to the requester half, never costing the runner', () => {
    const s = splitFee(cents(12525)); // 1503 total
    expect(s.requesterFeeCents + s.runnerFeeCents).toBe(s.totalTakeCents);
    expect(s.requesterFeeCents).toBeGreaterThanOrEqual(s.runnerFeeCents);
  });

  it('does not charge a fee on goods, bonus or reimbursement', () => {
    const { depositCents, split: sp } = depositTotal({ agreedFeeCents: cents(30000), goodsCapCents: cents(100000), bonusCents: cents(5000) });
    expect(depositCents).toBe(30000 + 100000 + 5000 + sp.requesterFeeCents);
    const { payoutCents } = disbursementTotal({ agreedFeeCents: cents(30000), bonusCents: cents(5000), reimbursementCents: cents(14000) });
    expect(payoutCents).toBe(30000 - 1800 + 5000 + 14000);
  });

  it('keeps only the requester half on a cancellation after assignment', () => {
    const sp = splitFee(cents(30000));
    const r = refundAfterAssignment({ depositCents: cents(140000), split: sp, cancellationFeeCents: cents(15000) });
    expect(r.platformKeepsCents).toBe(1800);
    expect(r.refundCents + r.runnerCents + r.platformKeepsCents).toBe(140000);
  });
});

describe('money', () => {
  it('rejects fractional minor units', () => {
    expect(() => cents(1.5)).toThrow(MoneyError);
  });
  it('refuses to add two currencies', () => {
    expect(() => addM(money(1, 'KES'), { minor: cents(1), currency: 'USD' })).toThrow(MoneyError);
  });
  it('gates currencies that are not enabled, and zero-decimal ones loudly', () => {
    expect(() => assertSupported('UGX')).toThrow(/0-decimal/);
    expect(() => assertSupported('USD')).toThrow(CurrencyError);
    expect(() => assertMarketsConsistent()).not.toThrow();
  });
  it('formats from the registry exponent', () => {
    expect(format(money(38000, 'KES'))).toBe('KSh 380');
    expect(format(money(38050, 'KES'))).toBe('KSh 380.50');
    expect(formatKes(cents(62000))).toBe('KSh 620');
  });
  it('splits exactly, with the remainder to the earliest shares', () => {
    expect(split(cents(10), 3)).toEqual([4, 3, 3]);
    expect(() => split(cents(-5), 2)).toThrow(MoneyError);
  });
});

describe('errand state machine', () => {
  it('walks the market-run happy path', () => {
    let s = nextStatus('draft', 'publish', 'requester');
    s = nextStatus(s, 'fund', 'system');
    s = nextStatus(s, 'offer', 'requester');
    s = nextStatus(s, 'accept', 'runner');
    s = nextStatus(s, 'start', 'runner');
    s = nextStatus(s, 'arrive', 'runner');
    s = nextStatus(s, 'submit_stall', 'runner');
    s = nextStatus(s, 'approve_stall', 'requester');
    s = nextStatus(s, 'all_stalls_done', 'system');
    s = nextStatus(s, 'handover_scanned', 'runner');
    expect(s).toBe('settled');
  });
  it('does not let a runner approve their own stall', () => {
    expect(() => nextStatus('awaiting_approval', 'approve_stall', 'runner')).toThrow(IllegalTransitionError);
  });
  it('only lets Legal Operations resolve a dispute', () => {
    expect(canTransition('disputed', 'resolve_dispute', 'requester')).toBe(false);
    expect(canTransition('disputed', 'resolve_dispute', 'legal_ops')).toBe(true);
  });
});

describe('sanitize', () => {
  it('canonicalises three spellings of one number to one', () => {
    expect(cleanMsisdn('0722000111')).toBe('+254722000111');
    expect(cleanMsisdn('+254722000111')).toBe('+254722000111');
    expect(cleanMsisdn('254 722 000 111')).toBe('+254722000111');
  });
  it('strips bidi overrides and zero-width characters from names', () => {
    expect(cleanName('display_name', 'A‮le​x')).toBe('Alex');
    expect(cleanName('display_name', "Ng'ang'a")).toBe("Ng'ang'a");
    expect(() => cleanName('display_name', '<script>')).toThrow(InvalidTextError);
  });
  it('neutralises markup in prose and formulas in CSV', () => {
    expect(cleanProse('reason', 'price was 3 < 5')).toBe('price was 3 ‹ 5');
    expect(csvCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
  });
  it('builds object keys server-side and refuses traversal', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(kycObjectKey(id, id, 'selfie', 'jpg')).toBe(`kyc/${id}/${id}/selfie.jpg`);
    expect(() => kycObjectKey(id, id, '../x', 'jpg')).toThrow(InvalidTextError);
  });
});

describe('link handshake', () => {
  const errandId = '11111111-1111-4111-8111-111111111111';
  const req = generateDeviceKeys(), run = generateDeviceKeys();
  const reqPub = rawPublicKey(req.publicKey), runPub = rawPublicKey(run.publicKey);

  it('both devices derive the same secret and the same hash', () => {
    expect(deriveSecret(req.privateKey, runPub).equals(deriveSecret(run.privateKey, reqPub))).toBe(true);
    expect(linkHash(reqPub, runPub, errandId)).toHaveLength(32);
  });

  it('verifies a genuine fix and rejects a forged or replayed one', () => {
    const secret = deriveSecret(run.privateKey, reqPub);
    const fix = { lat: -1.2641, lng: 36.7519, accuracyM: 12, headingDeg: 90, recordedAt: '2026-09-30T10:00:00Z' };
    const tag = tagFix(secret, errandId, 5, fix);
    const peer = deriveSecret(req.privateKey, runPub);
    expect(verifyFix({ secret: peer, errandId, seq: 5, fix, tag, lastAcceptedSeq: 4, state: 'active' })).toEqual({ ok: true });
    expect(verifyFix({ secret: peer, errandId, seq: 5, fix: { ...fix, lat: -1.3 }, tag, lastAcceptedSeq: 4, state: 'active' }))
      .toEqual({ ok: false, reason: 'bad_tag' });
    expect(verifyFix({ secret: peer, errandId, seq: 5, fix, tag, lastAcceptedSeq: 5, state: 'active' }))
      .toEqual({ ok: false, reason: 'stale_seq' });
    expect(verifyFix({ secret: peer, errandId, seq: 5, fix, tag, lastAcceptedSeq: 4, state: 'pending_ack' }))
      .toEqual({ ok: false, reason: 'link_inactive' });
  });

  it('a runner in a dead zone is linked_stale, never unknown', () => {
    expect(presence('active', null)).toBe('linked_stale');
    expect(presence('active', Date.now())).toBe('live');
  });
});

describe('eta', () => {
  const stat = () => ({ medianSecs: 600, p90Secs: 900, samples: 50, isSeed: false });
  const cp = (kind: Checkpoint['kind'], stallId: string | null = null): Checkpoint => ({ kind, stallId, reachedAt: 0 });

  it('counts progress from checkpoints actually reached', () => {
    expect(percentComplete([], 3)).toBe(0);
    expect(percentComplete([cp('assigned'), cp('en_route'), cp('arrived')], 3)).toBe(30);
    expect(percentComplete([cp('assigned'), cp('en_route'), cp('arrived'), cp('handover')], 3)).toBe(50);
  });

  it('shows a range, not a time, at low confidence', () => {
    const out = computeEta({ now: 0, checkpoints: [], stallCount: 2, stat, lastFixAtMs: null, metresToPickup: null });
    expect(out.confidence).toBe('low');
    expect(shouldShowExactTime(out.confidence)).toBe(false);
  });

  it('widens the band when the fix is stale rather than freezing', () => {
    const now = 10_000_000;
    const fresh = computeEta({ now, checkpoints: [cp('assigned')], stallCount: 1, stat, lastFixAtMs: now, metresToPickup: null });
    const stale = computeEta({ now, checkpoints: [cp('assigned')], stallCount: 1, stat, lastFixAtMs: now - 600_000, metresToPickup: null });
    expect(stale.etaHighMs!).toBeGreaterThan(fresh.etaHighMs!);
    expect(stale.confidence).toBe('low');
  });

  it('pays the bonus on the handover timestamp, never the estimate', () => {
    expect(bonusEarned(100, 200)).toBe(true);
    expect(bonusEarned(300, 200)).toBe(false);
    expect(bonusEarned(100, null)).toBe(false);
  });
});

describe('tiers and tranches', () => {
  it('only tier 3 may be awarded a card-carrying errand', () => {
    expect(entitlementsFor(2)).not.toContain('errand.accept');
    expect(entitlementsFor(3)).toContain('errand.accept');
    expect(minimumTierFor('bid.place')).toBe(2);
  });

  it('refuses an approval over the remaining cap rather than clamping', () => {
    expect(() => planTranche(
      { errandId: 'e', spendCapCents: cents(100000), spentCents: cents(70000) },
      { stallId: 's', seq: 2, totalCents: cents(38000), tillNumber: null, status: 'photographed' },
    )).toThrow(SpendCapExceededError);
  });
});
