// apps/api/src/lib/assignment.ts
// The two things every assignment path shares: making an exclusive, expiring offer, and what
// happens once a runner is assigned — whichever of pick, open or auction put them there.

import type { Tx } from '@sidequest/db';
import { enqueueOutbox } from '@sidequest/db';
import { nextStatus } from '@sidequest/domain/errand/machine';
import { splitFee } from '@sidequest/domain/pricing/fees';
import { cents } from '@sidequest/domain/money/money';
import { AppError, conflict } from '../plugins/errors.js';
import { lockErrand, assertRequester } from './errands.js';

export const OFFER_TTL_SECONDS = 90;

export async function makeOffer(tx: Tx, a: { errandId: string; requesterId: string; runnerId: string; feeCents: number }) {
  const e = await lockErrand(tx, a.errandId);
  assertRequester(e, a.requesterId);
  if (e.runner_id) throw conflict('ALREADY_ASSIGNED', 'This errand already has a runner');
  if (a.feeCents > e.max_fee_cents) {
    throw new AppError(400, 'VALIDATION', 'Fee is above your maximum', { max_fee_cents: e.max_fee_cents });
  }
  if (a.runnerId === a.requesterId) throw new AppError(400, 'VALIDATION', 'You cannot run your own errand');
  // Re-offering to someone else replaces a pending offer; the machine allows offer only from
  // open, so a live offer is first lapsed back to open.
  const from = e.status === 'offered' ? nextStatus('offered', 'offer_lapsed', 'system') : e.status;
  const to = nextStatus(from, 'offer', 'requester');
  const expiresAt = new Date(Date.now() + OFFER_TTL_SECONDS * 1000);

  await tx`UPDATE errand_offer SET outcome = 'withdrawn', resolved_at = now()
            WHERE errand_id = ${a.errandId} AND outcome = 'pending'`;
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO errand_offer (errand_id, runner_id, fee_cents, expires_at)
    VALUES (${a.errandId}, ${a.runnerId}, ${a.feeCents}, ${expiresAt}) RETURNING id`;
  await tx`
    UPDATE errand SET status = ${to}, offered_to = ${a.runnerId}, offered_at = now(),
           offer_expires_at = ${expiresAt}, agreed_fee_cents = ${a.feeCents}, updated_at = now()
     WHERE id = ${a.errandId} AND runner_id IS NULL`;
  await enqueueOutbox(tx, 'notify', {
    accountId: a.runnerId, template: 'errand.offered',
    vars: { errandId: a.errandId, feeCents: a.feeCents, expiresAt: expiresAt.toISOString() },
  });
  await enqueueOutbox(tx, 'offer.expire', { offerId: row!.id, errandId: a.errandId }, { delaySeconds: OFFER_TTL_SECONDS });
  return { offer_id: row!.id, expires_at: expiresAt.toISOString() };
}

/**
 * The fee is frozen at the agreed amount (never recomputed from a rate later). Issuing the card
 * and writing the `assigned` checkpoint belong to the money and progress services, via the
 * outbox, so the request that won the race stays short.
 */
export async function onAssigned(tx: Tx, a: { errandId: string; runnerId: string; feeCents: number; rateBps: number }) {
  const split = splitFee(cents(a.feeCents), a.rateBps);
  await tx`
    INSERT INTO errand_fee (errand_id, base_cents, rate_bps, requester_fee_cents, runner_fee_cents, currency)
    VALUES (${a.errandId}, ${split.baseCents}, ${split.rateBps}, ${split.requesterFeeCents}, ${split.runnerFeeCents}, 'KES')
    ON CONFLICT (errand_id) DO NOTHING`;
  await enqueueOutbox(tx, 'errand.assigned', { errandId: a.errandId, runnerId: a.runnerId });
  await enqueueOutbox(tx, 'notify', { accountId: a.runnerId, template: 'errand.awarded', vars: { errandId: a.errandId } });
}
