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

import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import type { IssuerPort, IssuedCard, LoadResult } from '@sidequest/domain/card/issuer.port';
import { cents, type Cents } from '@sidequest/domain/money/money';

export class MockIssuer implements IssuerPort {
  constructor(private readonly redis: Redis, private readonly prefix = 'mockissuer') {}

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
      result = { ok: true, providerRef: `mock_load_${createHash('sha256').update(args.idemKey).digest('hex').slice(0, 12)}` };
    }
    await this.redis.set(this.k('load', args.idemKey), JSON.stringify(result));
    return result;
  }

  async voidCard(args: { issuerRef: string; idemKey: string }): Promise<void> {
    await this.redis.hset(this.k('card', args.issuerRef), { voided: '1', balance: '0' });
  }

  async getLoad(args: { issuerRef: string; idemKey: string }) {
    const prior = await this.redis.get(this.k('load', args.idemKey));
    if (!prior) return { status: 'unknown' as const };
    const r = JSON.parse(prior) as LoadResult;
    return r.ok ? { status: 'succeeded' as const, providerRef: r.providerRef } : { status: 'failed' as const, code: r.code };
  }

  async getBalance(issuerRef: string): Promise<Cents> {
    const b = await this.redis.hget(this.k('card', issuerRef), 'balance');
    return cents(Number(b ?? 0));
  }
}
