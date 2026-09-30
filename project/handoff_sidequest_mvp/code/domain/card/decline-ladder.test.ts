// packages/domain/src/card/decline-ladder.test.ts
// The ladder is the rule most likely to be broken by a well-meaning refactor.
// These tests are the specification.

import { describe, it, expect } from 'vitest';
import { nextStep, type Attempt, type LadderContext } from './decline-ladder.js';
import { cents } from '../money/money.js';

const base = (over: Partial<LadderContext> = {}): LadderContext => ({
  attempts: [],
  amountCents: cents(84000),
  remainingCapCents: cents(266000),
  tillNumber: '174379',
  reimbursementConfirmed: null,
  confirmationWindowExpired: false,
  ...over,
});

const a = (rung: Attempt['rung'], result: Attempt['result'], code: string | null = null): Attempt =>
  ({ rung, result, code });

describe('decline ladder', () => {
  it('starts on the card', () => {
    expect(nextStep(base())).toEqual({ action: 'load_card', rung: 'card', attempt: 1 });
  });

  it('retries once for a retryable failure', () => {
    const ctx = base({ attempts: [a('card', 'timeout', 'issuer_timeout')] });
    expect(nextStep(ctx)).toEqual({ action: 'load_card', rung: 'card_retry', attempt: 2 });
  });

  it('does NOT retry a hard decline — it drops straight to the till', () => {
    const ctx = base({ attempts: [a('card', 'declined', 'insufficient_funds')] });
    expect(nextStep(ctx)).toMatchObject({ action: 'pay_till', tillNumber: '174379' });
  });

  it('never retries the card more than once', () => {
    const ctx = base({
      attempts: [a('card', 'timeout', 'issuer_timeout'), a('card_retry', 'timeout', 'issuer_timeout')],
    });
    expect(nextStep(ctx)).toMatchObject({ action: 'pay_till' });
  });

  it('skips the till rung when the stall has no till number', () => {
    const ctx = base({ tillNumber: null, attempts: [a('card', 'declined', 'do_not_honour')] });
    expect(nextStep(ctx)).toEqual({ action: 'request_reimbursement', amountCents: cents(84000) });
  });

  it('caps reimbursement at the remaining spend cap', () => {
    const ctx = base({
      tillNumber: null,
      amountCents: cents(84000),
      remainingCapCents: cents(50000),
      attempts: [a('card', 'declined', 'do_not_honour')],
    });
    expect(nextStep(ctx)).toEqual({ action: 'request_reimbursement', amountCents: cents(50000) });
  });

  it('escalates rather than reimbursing nothing when the cap is exhausted', () => {
    const ctx = base({
      tillNumber: null,
      remainingCapCents: cents(0),
      attempts: [a('card', 'declined', 'do_not_honour')],
    });
    expect(nextStep(ctx)).toEqual({ action: 'escalate', reason: 'cap_exhausted' });
  });

  it('waits while the requester has not answered', () => {
    const ctx = base({
      tillNumber: null,
      attempts: [a('card', 'declined', 'do_not_honour'), a('reimbursement', 'pending')],
    });
    expect(nextStep(ctx)).toEqual({ action: 'wait', reason: 'awaiting_confirmation' });
  });

  it('escalates when the confirmation window closes unanswered', () => {
    const ctx = base({
      tillNumber: null,
      confirmationWindowExpired: true,
      attempts: [a('card', 'declined', 'do_not_honour'), a('reimbursement', 'error')],
    });
    expect(nextStep(ctx)).toEqual({ action: 'escalate', reason: 'confirmation_timeout' });
  });

  it('escalates when the requester declines to reimburse', () => {
    const ctx = base({
      tillNumber: null,
      reimbursementConfirmed: false,
      attempts: [a('card', 'declined', 'do_not_honour'), a('reimbursement', 'error')],
    });
    expect(nextStep(ctx)).toEqual({ action: 'escalate', reason: 'no_rung_left' });
  });

  it('pays the reimbursement once confirmed', () => {
    const ctx = base({
      tillNumber: null,
      reimbursementConfirmed: true,
      attempts: [a('card', 'declined', 'do_not_honour'), a('reimbursement', 'error')],
    });
    expect(nextStep(ctx)).toEqual({ action: 'pay_reimbursement', amountCents: cents(84000) });
  });

  it('is idempotent once any rung has succeeded', () => {
    for (const rung of ['card', 'card_retry', 'mpesa_till', 'reimbursement'] as const) {
      expect(nextStep(base({ attempts: [a(rung, 'success')] }))).toEqual({ action: 'done' });
    }
  });
});
