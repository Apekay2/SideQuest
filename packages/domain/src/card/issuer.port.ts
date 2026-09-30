// packages/domain/src/card/issuer.port.ts
// The boundary between the domain and whichever card issuer we are on this quarter.
// Nothing in `domain` knows the provider's name.

import type { Cents } from '../money/money.js';

export interface IssuedCard {
  issuerRef: string;
  last4: string;
}

export type LoadResult =
  | { ok: true; providerRef: string }
  | { ok: false; retryable: boolean; code: string; message: string };

export interface IssuerPort {
  /**
   * Create a single-errand card with a hard ceiling. MUST be idempotent on `idemKey`:
   * a repeat call returns the same card rather than issuing a second one.
   */
  createCard(args: {
    errandId: string;
    ceilingCents: Cents;
    holderName: string;
    idemKey: string;
  }): Promise<IssuedCard>;

  /** Add spendable value. MUST be idempotent on `idemKey`. */
  loadCard(args: {
    issuerRef: string;
    amountCents: Cents;
    idemKey: string;
  }): Promise<LoadResult>;

  /** Remove all remaining value and close the card. Safe to call more than once. */
  voidCard(args: { issuerRef: string; idemKey: string }): Promise<void>;

  /**
   * What happened to an earlier load, looked up by the idempotency key we sent.
   *
   * Required by the crash-recovery path in card-load.job.ts: a process that dies between
   * the issuer call and the local commit leaves a card that may hold real money and a
   * tranche that says `pending`. Without this method the only recovery is a human reading
   * the issuer's dashboard, which is not a recovery procedure at 500 errands a day.
   *
   * `unknown` is a legitimate answer and MUST NOT be reported as a failure — an adapter that
   * guesses here will either double-load a card or strand a runner in a market.
   */
  getLoad(args: { issuerRef: string; idemKey: string }): Promise<
    | { status: 'succeeded'; providerRef: string }
    | { status: 'failed'; code: string }
    | { status: 'unknown' }
  >;

  /** Authoritative balance, for reconciliation only — never for an authorisation decision. */
  getBalance(issuerRef: string): Promise<Cents>;
}

/** Provider codes we treat as retryable. Anything unlisted is terminal. */
export const RETRYABLE_CODES = new Set([
  'issuer_timeout', 'rate_limited', 'temporary_failure', 'network_error', 'service_unavailable',
]);

export function classify(code: string): { retryable: boolean } {
  return { retryable: RETRYABLE_CODES.has(code) };
}
