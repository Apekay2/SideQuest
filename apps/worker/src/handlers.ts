// apps/worker/src/handlers.ts
// Queue name → handler. An outbox row naming a queue that is not here is parked by the
// poller for a human, never silently dropped (panel review, finding P-3).

import type { Handler } from './context.js';
import { cardLoad } from './jobs/card-load.job.js';
import {
  errandAssigned, cardVoid, errandSettle, errandRefund, errandExpire, disputeOpened, disputeRuled,
} from './jobs/money.js';
import { paymentStk, mpesaCallback, payoutSend, paymentWithdraw, issuerEvent } from './jobs/payments.js';
import { checkpointRecord, etaRecompute } from './jobs/progress.js';
import { notify } from './jobs/notify.js';
import { offerExpire, evidenceReject, linkRevoke, errandPublished, sosOpened } from './jobs/lifecycle.js';

export const HANDLERS: Readonly<Record<string, Handler>> = Object.freeze({
  // money
  'errand.assigned': errandAssigned,
  'card.load': cardLoad,
  'card.void': cardVoid,
  'errand.settle': errandSettle,
  'errand.refund': errandRefund,
  'errand.expire': errandExpire,
  'dispute.opened': disputeOpened,
  'dispute.ruled': disputeRuled,
  // payments
  'payment.stk': paymentStk,
  'mpesa.callback': mpesaCallback,
  'payout.send': payoutSend,
  'payment.withdraw': paymentWithdraw,
  'issuer.event': issuerEvent,
  // progress
  'checkpoint.record': checkpointRecord,
  'eta.recompute': etaRecompute,
  // notify and lifecycle
  'notify': notify,
  'offer.expire': offerExpire,
  'evidence.reject': evidenceReject,
  'link.revoke': linkRevoke,
  'errand.published': errandPublished,
  'sos.opened': sosOpened,
});
