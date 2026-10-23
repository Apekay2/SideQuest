// packages/adapters/src/issuer/index.ts
// Card issuers behind IssuerPort (domain/card/issuer.port.ts).
//
// MockIssuer keeps its state in Redis rather than memory so that `getLoad` still answers after
// a worker restart — which is exactly the crash-recovery path card-load.job.ts depends on and
// the one a memory-only mock could never exercise. Config refuses the mock in production.
//
// Deterministic outcomes for driving the decline ladder from the app:
//   - a load whose shilling amount ends in 13  → hard decline 'do_not_honour'
//   - a load whose shilling amount ends in 17  → 'issuer_timeout' (retryable), every time
//   anything else succeeds.
//
// Spending: a real card's balance falls when the runner taps it at a till. The mock has no
// till, so `simulateSpend` stands in for one, and `autoSpend` (development) spends each load
// in full immediately — as if the runner paid exactly the approved stall total. Without it,
// settlement correctly returns the whole loaded balance to escrow as unspent.

import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import type { IssuerPort, IssuedCard, LoadResult } from '@sidequest/domain/card/issuer.port';
import { cents, type Cents } from '@sidequest/domain/money/money';

export class MockIssuer implements IssuerPort {
  constructor(
    private readonly redis: Redis,
    private readonly opts: { prefix?: string; autoSpend?: boolean } = {},
  ) {}

  private get prefix() { return this.opts.prefix ?? 'mockissuer'; }

  private k(...parts: string[]) { return [this.prefix, ...parts].join(':'); }

  async createCard(args: { errandId: string; ceilingCents: Cents; holderName: string; idemKey: string }): Promise<IssuedCard> {
    const existing = await this.redis.get(this.k('create', args.idemKey));
    if (existing) return JSON.parse(existing) as IssuedCard;
    const digest = createHash('sha256').update(args.idemKey).digest('hex');
    const card: IssuedCard = {
      issuerRef: `mock_card_${digest.slice(0, 16)}`,
      last4: String(parseInt(digest.slice(0, 8), 16) % 10_000).padStart(4, '0'),
    };
    // SET NX: two concurrent creates with one key issue one card.
    const won = await this.redis.set(this.k('create', args.idemKey), JSON.stringify(card), 'NX');
    if (!won) return JSON.parse((await this.redis.get(this.k('create', args.idemKey)))!) as IssuedCard;
    await this.redis.hset(this.k('card', card.issuerRef), { balance: '0', ceiling: String(args.ceilingCents), voided: '0' });
    return card;
  }

  async loadCard(args: { issuerRef: string; amountCents: Cents; idemKey: string }): Promise<LoadResult> {
    const prior = await this.redis.get(this.k('load', args.idemKey));
    if (prior) return JSON.parse(prior) as LoadResult;

    const card = await this.redis.hgetall(this.k('card', args.issuerRef));
    let result: LoadResult;
    const shillings = Math.floor(args.amountCents / 100);
    if (!card.balance) {
      result = { ok: false, retryable: false, code: 'card_not_found', message: 'Unknown card' };
    } else if (card.voided === '1') {
      result = { ok: false, retryable: false, code: 'card_closed', message: 'Card is closed' };
    } else if (shillings % 100 === 13) {
      result = { ok: false, retryable: false, code: 'do_not_honour', message: 'Declined' };
    } else if (shillings % 100 === 17) {
      // Retryable failures are not memoised: a retry with a NEW key (card_retry) must be able
      // to reach the issuer again, as it would in life.
      return { ok: false, retryable: true, code: 'issuer_timeout', message: 'Issuer timed out' };
    } else {
      await this.redis.hincrby(this.k('card', args.issuerRef), 'balance', args.amountCents);
      if (this.opts.autoSpend) await this.simulateSpend(args.issuerRef, args.amountCents);
      result = { ok: true, providerRef: `mock_load_${createHash('sha256').update(args.idemKey).digest('hex').slice(0, 12)}` };
    }
    await this.redis.set(this.k('load', args.idemKey), JSON.stringify(result));
    return result;
  }

  /** A purchase at a till. Refuses to overdraw, as the issuer's ceiling would. */
  async simulateSpend(issuerRef: string, amountCents: number): Promise<void> {
    const left = Number(await this.redis.hget(this.k('card', issuerRef), 'balance') ?? 0);
    if (amountCents > left) throw new Error(`mock card ${issuerRef} has ${left}, cannot spend ${amountCents}`);
    await this.redis.hincrby(this.k('card', issuerRef), 'balance', -amountCents);
  }

  /**
   * Close and sweep in one atomic step (a Lua script), remembering the result under the
   * idempotency key so a repeat answers the same amount, as a real issuer's close would.
   */
  async voidCard(args: { issuerRef: string; idemKey: string }): Promise<{ sweptCents: Cents }> {
    const swept = await this.redis.eval(
      `local prior = redis.call('GET', KEYS[2])
       if prior then return tonumber(prior) end
       local bal = tonumber(redis.call('HGET', KEYS[1], 'balance') or '0')
       redis.call('HSET', KEYS[1], 'voided', '1', 'balance', '0')
       redis.call('SET', KEYS[2], tostring(bal))
       return bal`,
      2, this.k('card', args.issuerRef), this.k('void', args.idemKey),
    );
    return { sweptCents: cents(Number(swept ?? 0)) };
  }

  async getLoad(args: { issuerRef: string; idemKey: string }) {
    const prior = await this.redis.get(this.k('load', args.idemKey));
    if (!prior) return { status: 'unknown' as const };
    const r = JSON.parse(prior) as LoadResult;
    // `in` narrows the union even when strictNullChecks is off (Vercel's function type-check
    // does not use our tsconfig); a truthiness check on `r.ok` does not.
    return 'providerRef' in r
      ? { status: 'succeeded' as const, providerRef: r.providerRef }
      : { status: 'failed' as const, code: r.code };
  }

  async getBalance(issuerRef: string): Promise<Cents> {
    const b = await this.redis.hget(this.k('card', issuerRef), 'balance');
    return cents(Number(b ?? 0));
  }
}

/**
 * `ISSUER_DRIVER=none`: launch without a card-issuing partner. Every errand still gets a card
 * row (the tranche, ladder and ledger shapes are unchanged), but nothing is ever loaded on it:
 * each load is a terminal decline, so the decline ladder goes straight to the vendor's M-Pesa
 * till and then to requester-approved cash reimbursement — both of which exist without a card
 * partner. When an issuer is signed, its adapter replaces this and the card rung comes back.
 */
export class NoCardIssuer implements IssuerPort {
  async createCard(args: { errandId: string; ceilingCents: Cents; holderName: string; idemKey: string }): Promise<IssuedCard> {
    return { issuerRef: `nocard:${args.errandId}`, last4: '0000' };
  }

  async loadCard(): Promise<LoadResult> {
    return { ok: false, retryable: false, code: 'card_unavailable', message: 'No card issuer is configured' };
  }

  async voidCard(): Promise<{ sweptCents: Cents }> {
    return { sweptCents: cents(0) };
  }

  async getLoad() {
    return { status: 'failed' as const, code: 'card_unavailable' };
  }

  async getBalance(): Promise<Cents> {
    return cents(0);
  }
}
