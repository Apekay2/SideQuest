// apps/worker/src/jobs/safety.ts
// SOS escalation and the stuck-errand watchdog: the two jobs whose purpose is to put a problem
// in front of a person, and to keep doing so until one picks it up.

import { enqueueOutbox, type Sql } from '@sidequest/db';
import { nextStatus, STUCK_AFTER_HOURS, type ErrandStatus } from '@sidequest/domain/errand/machine';
import { metrics } from '@sidequest/observability';
import type { SmsPort } from '@sidequest/adapters';
import { type Handler, type JobContext, later, str } from '../context.js';
import type { Alerter } from '../alert.js';

// ─────────────────────────────────────────────── SOS

/** Re-page this often until someone acknowledges in the console. */
export const SOS_REPAGE_SECONDS = 60;
/** Fifteen pages (fifteen minutes); the last says it is the last. Bounded, never a loop. */
export const SOS_MAX_PAGES = 15;

/** Short, unambiguous reference an officer can type into the console search. */
const ref = (id: string) => `SOS-${id.slice(0, 8).toUpperCase()}`;

/**
 * Page the safety on-call for one SOS case, then schedule the next page unless someone has
 * acknowledged or resolved it. Round 0 is the SOS itself (from the API's outbox row).
 */
export async function pageSos(ctx: JobContext, sosId: string, round: number): Promise<'paged' | 'handled' | 'missing'> {
  const { sql, cfg, sms } = ctx.deps;
  const [c] = await sql<{ id: string; errand_id: string; acknowledged_at: Date | null; resolved_at: Date | null; created_at: Date }[]>`
    SELECT id, errand_id, acknowledged_at, resolved_at, created_at FROM sos_case WHERE id = ${sosId}`;
  if (!c) { ctx.log.error({ sosId }, 'SOS case not found'); return 'missing'; }
  if (c.acknowledged_at || c.resolved_at) return 'handled';

  const minutes = Math.max(0, Math.round((Date.now() - c.created_at.getTime()) / 60_000));
  const last = round + 1 >= SOS_MAX_PAGES;
  const text = round === 0
    ? `SIDE QWEST SOS ${ref(c.id)}: raised just now. Open the console SOS queue and acknowledge.`
    : `SIDE QWEST SOS ${ref(c.id)}: raised ${minutes} min ago, NOT yet acknowledged.${last ? ' Final page.' : ''} Open the console SOS queue now.`;

  ctx.log.fatal({ sos: c.id, errand: c.errand_id, round }, 'SOS not yet acknowledged — paging the safety on-call');
  metrics.increment(round === 0 ? 'sos.opened' : 'sos.repaged');
  await smsAll(ctx, sms, cfg.SAFETY_ONCALL_MSISDNS, text);
  await ctx.deps.alert({
    severity: 'page',
    title: round === 0 ? `SOS raised (${ref(c.id)})` : `SOS still unacknowledged after ${minutes} min (${ref(c.id)})`,
    data: { sos_id: c.id, errand_id: c.errand_id, round, final: last },
  });

  await sql.begin(async (tx) => {
    await tx`UPDATE sos_case SET escalations = escalations + 1, last_escalated_at = now() WHERE id = ${c.id}`;
    if (!last) await later(tx, 'sos.escalate', { sosId: c.id, round: round + 1 }, SOS_REPAGE_SECONDS);
  });
  return 'paged';
}

/** One failed number must not stop the others from being paged. */
async function smsAll(ctx: JobContext, sms: SmsPort, numbers: readonly string[], text: string) {
  if (numbers.length === 0) {
    ctx.log.error('no SAFETY_ONCALL_MSISDNS configured; the SOS page went to the alert channel only');
    return;
  }
  for (const to of numbers) {
    try { await sms.send(to, text); } catch (err) {
      metrics.increment('sos.page_failed');
      ctx.log.error({ err, to: `…${to.slice(-3)}` }, 'could not page an on-call number');
    }
  }
}

export const sosOpened: Handler = async (payload, ctx) => {
  await pageSos(ctx, str(payload, 'sosId'), 0);
};

export const sosEscalate: Handler = async (payload, ctx) => {
  const round = Number(payload.round ?? 1);
  await pageSos(ctx, str(payload, 'sosId'), Number.isInteger(round) && round > 0 ? round : 1);
};

// ─────────────────────────────────────────────── stuck errands

const STUCK_STATES = Object.keys(STUCK_AFTER_HOURS) as ErrandStatus[];

export interface WatchdogDeps { sql: Sql; alert: Alerter }

/**
 * Hand every errand that has made no progress for too long to Legal Operations: open a
 * system dispute (which freezes escrow and voids the card through dispute.opened), tell both
 * parties, and raise a ticket. Without it, a requester who never showed the handover QR — or a
 * runner who vanished mid-run — left money in escrow with no timer that would ever return it.
 *
 * Safe to run on several workers at once: each errand is claimed with SKIP LOCKED and
 * re-checked under its lock.
 */
export async function watchdog(deps: WatchdogDeps, limit = 50): Promise<string[]> {
  const raised: string[] = [];
  for (const status of STUCK_STATES) {
    const hours = STUCK_AFTER_HOURS[status]!;
    const ids = await deps.sql<{ id: string }[]>`
      SELECT id FROM errand
       WHERE status = ${status} AND updated_at < now() - make_interval(hours => ${hours})
       ORDER BY updated_at LIMIT ${limit}`;
    for (const { id } of ids) {
      const done = await deps.sql.begin(async (tx) => {
        const [e] = await tx<{ id: string; status: ErrandStatus; requester_id: string; runner_id: string | null; stuck: boolean }[]>`
          SELECT id, status, requester_id, runner_id,
                 updated_at < now() - make_interval(hours => ${hours}) AS stuck
            FROM errand WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
        if (!e || e.status !== status || !e.stuck) return null;
        const open = await tx`SELECT 1 FROM dispute WHERE errand_id = ${id} AND status IN ('open','evidence')`;
        if (open.length) return null;
        const [d] = await tx<{ id: string }[]>`
          INSERT INTO dispute (errand_id, raised_by, origin, reason, detail)
          VALUES (${id}, NULL, 'system', 'other',
                  ${`Raised automatically: the errand has been "${status}" for over ${hours} hours with no progress. Escrow is frozen until Legal Operations rules.`})
          RETURNING id`;
        await tx`UPDATE errand SET status = ${nextStatus(status, 'raise_dispute', 'system')}, updated_at = now() WHERE id = ${id}`;
        await enqueueOutbox(tx, 'dispute.opened', { disputeId: d!.id, errandId: id });
        for (const who of [e.requester_id, e.runner_id]) {
          if (who) await enqueueOutbox(tx, 'notify', { accountId: who, template: 'dispute.opened', vars: { errandId: id } });
        }
        return { disputeId: d!.id, parties: [e.requester_id, e.runner_id] };
      });
      if (!done) continue;
      raised.push(id);
      metrics.increment('errand.watchdog_dispute', { status });
      await deps.alert({
        severity: 'ticket',
        title: `Stuck errand handed to Legal Operations (${status} for over ${hours} h)`,
        data: { errand_id: id, dispute_id: done.disputeId, status },
      });
    }
  }
  return raised;
}

/** The watchdog as a queue job, so a test or an operator can trigger one pass. */
export const errandWatchdog: Handler = async (_payload, ctx) => {
  const raised = await watchdog({ sql: ctx.deps.sql, alert: ctx.deps.alert });
  if (raised.length) ctx.log.warn({ raised }, 'watchdog handed stuck errands to Legal Operations');
};
