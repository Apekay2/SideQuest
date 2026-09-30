// packages/domain/src/rails/mpesa.port.ts
// The boundary between the money core and Safaricom. Calls start an operation; every outcome
// arrives later as an MpesaResult (from a signature- and source-checked webhook), never as a
// synchronous return value. A rail that "confirms" inline is lying about M-Pesa.

import type { Cents } from '../money/money.js';

export interface MpesaPort {
  /** Prompt the customer's phone to pay into our paybill. Funding and top-ups. */
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
