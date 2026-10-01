// apps/worker/src/jobs/lifecycle.ts
// Timers and small state changes that belong to no request: offer lapse, evidence rejection,
// link revocation, discovery fan-out and SOS escalation.

import { nextStatus } from '@sidequest/domain/errand/machine';
import { metrics } from '@sidequest/observability';
import { type Handler, publish, str } from '../context.js';

/** The 90-second pick-mode offer ran out: the errand returns to open for another pick. */
export const offerExpire: Handler = async (payload, ctx) => {
  const offerId = str(payload, 'offerId');
  const requester = await ctx.deps.sql.begin(async (tx) => {
    const [o] = await tx<{ errand_id: string; runner_id: string }[]>`
      UPDATE errand_offer SET outcome = 'lapsed', resolved_at = now()
       WHERE id = ${offerId} AND outcome = 'pending' AND expires_at <= now()
      RETURNING errand_id, runner_id`;
    if (!o) return null;
    const [e] = await tx<{ requester_id: string }[]>`
      UPDATE errand SET status = ${nextStatus('offered', 'offer_lapsed', 'system')}, offered_to = NULL,
             offer_expires_at = NULL, updated_at = now()
       WHERE id = ${o.errand_id} AND status = 'offered' AND runner_id IS NULL AND offered_to = ${o.runner_id}
      RETURNING requester_id`;
    return e?.requester_id ?? null;
  });
  await publish(ctx.deps, requester, 'offer.lapsed', { errand_id: payload.errandId ?? null });
};

/** The requester sent a photo back; the evidence row is marked, never rewritten. */
export const evidenceReject: Handler = async (payload, ctx) => {
  const id = typeof payload.evidenceId === 'string' ? payload.evidenceId : null;
  if (id) await ctx.deps.sql`UPDATE evidence SET rejected = true WHERE id = ${id}`;
};

/** Settlement or cancellation ends location sharing; both devices wipe the derived secret. */
export const linkRevoke: Handler = async (payload, ctx) => {
  const errandId = str(payload, 'errandId');
  const parties = await ctx.deps.sql.begin(async (tx) => {
    await tx`UPDATE errand_link SET revoked_at = COALESCE(revoked_at, now()) WHERE errand_id = ${errandId}`;
    await tx`UPDATE runner_location SET errand_id = NULL, is_online = false WHERE errand_id = ${errandId}`;
    const [e] = await tx<{ requester_id: string; runner_id: string | null }[]>`
      SELECT requester_id, runner_id FROM errand WHERE id = ${errandId}`;
    return e;
  });
  await ctx.deps.redis.del(`loc:cur:${errandId}`, `loc:req:${errandId}`);
  for (const who of [parties?.requester_id, parties?.runner_id]) await publish(ctx.deps, who, 'link.revoked', { errand_id: errandId });
};

/**
 * A funded errand is open: tell verified runners nearby, by socket only. The requester's
 * exact point is not in the event — runners see the errand in their feed, banded.
 */
export const errandPublished: Handler = async (payload, ctx) => {
  const errandId = str(payload, 'errandId');
  const runners = await ctx.deps.sql<{ runner_id: string }[]>`
    SELECT rl.runner_id FROM runner_location rl JOIN errand e ON e.id = ${errandId}
     WHERE rl.is_online AND rl.errand_id IS NULL AND rl.runner_id <> e.requester_id
       AND ST_DWithin(rl.point, COALESCE(e.pickup, e.dropoff), 3000)
       AND rl.received_at > now() - interval '5 minutes'
     LIMIT 200`;
  for (const r of runners) await publish(ctx.deps, r.runner_id, 'feed.new', { errand_id: errandId });
  metrics.increment('feed.fanout', undefined, runners.length);
};

/**
 * SOS: the case is already recorded with its snapshot. This pages the on-call safety officer;
 * it never waits on anything, and it never fails quietly.
 */
export const sosOpened: Handler = async (payload, ctx) => {
  ctx.log.fatal({ sos: payload.sosId, errand: payload.errandId }, 'SOS raised — page the safety on-call');
  metrics.increment('sos.opened');
};
