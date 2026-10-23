// packages/domain/src/rails/mpesa.port.ts
// The boundary between the money core and Safaricom. Calls start an operation; every outcome
// arrives later as an MpesaResult (from a signature- and source-checked webhook), never as a
// synchronous return value. A rail that "confirms" inline is lying about M-Pesa.

import type { Cents } from '../money/money.js';

export interface MpesaPort {
  /**
   * Prompt the customer's phone to pay into our paybill. Funding and top-ups. `idemKey` is the
   * payment's id, and it comes back on the callback's URL: the callback body carries only
   * Safaricom's CheckoutRequestID (which a timed-out request never gave us) and a payer number
   * Safaricom masks, so the URL is the one thing we sent that is sure to return.
   */
  stkPush(args: {
    msisdn: string; amountCents: Cents; accountRef: string; description: string; idemKey: string;
  }): Promise<{ checkoutRef: string }>;

  /** Ladder rung 2: pay a vendor's till from the errand's held balance. */
  payTill(args: {
    tillNumber: string; amountCents: Cents; reference: string; idemKey: string;
  }): Promise<{ conversationId: string }>;

  /** Runner payout or requester withdrawal to a registered number. */
  b2c(args: { msisdn: string; amountCents: Cents; remarks: string; idemKey: string }): Promise<{ conversationId: string }>;
}

export interface MpesaResult {
  kind: 'stk' | 'till' | 'b2c';
  /** CheckoutRequestID for STK, ConversationID for till and B2C. */
  ref: string;
  ok: boolean;
  resultCode: string;
  resultDesc: string;
  amountCents: number | null;
  receipt: string | null;
  /**
   * Till and B2C results: the OriginatorConversationID we sent, `till:<idemKey>` or
   * `b2c:<idemKey>`. It is how a result is matched when the request that started it timed out
   * before Safaricom's ConversationID reached us.
   */
  originator?: string | null;
}

/**
 * The rail said no. Nothing was started, so it is safe to undo our side (reverse a debit, try
 * the next rung, tell the customer the push failed).
 */
export class MpesaRejectedError extends Error {
  readonly code = 'MPESA_REJECTED';
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'MpesaRejectedError';
  }
}

/**
 * We do not know what happened: a timeout, a dropped connection, a 5xx, an unreadable reply.
 * Safaricom may have accepted the request and will send its result to the callback URL. The
 * caller MUST NOT undo anything on this error — reversing a payout that in fact went out pays
 * the runner twice — and must leave the operation open for the callback (matched by its
 * originator id) or a human to close.
 */
export class MpesaUnknownOutcomeError extends Error {
  readonly code = 'MPESA_OUTCOME_UNKNOWN';
  constructor(message: string) {
    super(message);
    this.name = 'MpesaUnknownOutcomeError';
  }
}

/** True only for an error that proves the rail did nothing. Anything unrecognised is unknown. */
export function isDefinitiveRejection(err: unknown): boolean {
  return err instanceof MpesaRejectedError || err instanceof MpesaAmountError;
}

export class MpesaAmountError extends Error {
  readonly code = 'MPESA_WHOLE_SHILLINGS';
  constructor(amount: number) {
    super(`M-Pesa moves whole shillings only; ${amount} cents is not a whole shilling`);
  }
}

/** M-Pesa has no cents. Every amount crossing the rail is asserted whole before conversion. */
export function toShillings(amountCents: number): number {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents % 100 !== 0) {
    throw new MpesaAmountError(amountCents);
  }
  return amountCents / 100;
}
