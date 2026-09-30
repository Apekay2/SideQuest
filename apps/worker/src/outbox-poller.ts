// apps/worker/src/outbox-poller.ts
// Moves committed outbox rows into BullMQ. This is the only bridge between the database
// and the queue, which is what makes "enqueue inside a transaction" honest.
//
// CORRECTED (panel review, finding P-3). The previous version set `dispatched_at = now()`
// in the same statement that read the batch, and enqueued afterwards. Everything between
// that commit and the `queue.add` was an at-most-once window: a pod restart, an OOM kill, a
// Redis blip or an unknown queue name silently dropped the job for good. The rows dropped
// that way are `card.load` (a runner waiting in a market for a card that never loads),
// `errand.settle` (a runner never paid) and `notify`. A transactional outbox that loses
// rows is worse than no outbox, because everything upstream is written trusting it.
//
// Now: claim with a lease, enqueue, then mark dispatched. At-least-once, which BullMQ's
// `jobId` dedupe turns back into effectively-once. A claim whose lease expires is retried;
// a row that fails repeatedly is parked for a human instead of being retried forever.
//
// `dispatch` is injected: in production it adds a BullMQ job, in tests and the drain CLI it
// runs the handler inline. The claim/lease/park logic is the same code in both.

import type { Sql } from '@sidequest/db';
import { logger, metrics } from '@sidequest/observability';

const TICK_MS = 250;
const BATCH = 100;
const LEASE_MS = 30_000;
export const MAX_ATTEMPTS = 10;

export interface OutboxRow { id: string; eventId?: string; queue: string; payload: Record<string, unknown>; attempts: number }

export type Dispatch = (row: OutboxRow) => Promise<void>;

/** Claim due rows with a lease. SKIP LOCKED lets several workers drain one table. */
export async function claim(sql: Sql, opts: { ignoreDelay?: boolean; limit?: number } = {}): Promise<OutboxRow[]> {
  const rows = await sql<{ id: number; event_id: string; queue: string; payload: Record<string, unknown>; attempts: number }[]>`
    UPDATE outbox_event
       SET claimed_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM outbox_event
        WHERE dispatched_at IS NULL
          AND parked_at IS NULL
          ${opts.ignoreDelay ? sql`` : sql`AND available_at <= now()`}
          AND (claimed_at IS NULL OR claimed_at < now() - ${LEASE_MS} * interval '1 millisecond')
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT ${opts.limit ?? BATCH})
    RETURNING id, event_id, queue, payload, attempts`;
  return rows.map(({ event_id, ...r }) => ({ ...r, id: String(r.id), eventId: event_id })).sort((a, b) => Number(a.id) - Number(b.id));
}

/** Dispatch one claimed row; mark it done, or release/park it on failure. */
export async function settleRow(sql: Sql, row: OutboxRow, known: ReadonlySet<string>, dispatch: Dispatch): Promise<'done' | 'retry' | 'parked'> {
  const log = logger.child({ component: 'outbox', id: row.id, queue: row.queue });
  // An unknown queue name is a deploy-order bug, not a transient fault. Park it so it is
  // visible and countable, rather than logged once and forgotten. It used to be marked
  // dispatched, which meant "silently deleted".
  if (!known.has(row.queue)) {
    await sql`UPDATE outbox_event SET parked_at = now(), last_error = 'unknown queue' WHERE id = ${row.id}`;
    log.error('unknown queue, row parked');
    metrics.increment('outbox.parked', { reason: 'unknown_queue' });
    return 'parked';
  }
  try {
    await dispatch(row);
    // Only now is the row done. A crash before this line means the lease expires and the
    // row is redelivered; `jobId` (or handler idempotency) makes the duplicate a no-op.
    await sql`UPDATE outbox_event SET dispatched_at = now() WHERE id = ${row.id}`;
    return 'done';
  } catch (err) {
    const parked = row.attempts >= MAX_ATTEMPTS;
    // Exponential backoff on retry: available_at moves out, the lease is released.
    const backoffMs = Math.min(2 ** row.attempts * 500, 5 * 60_000);
    await sql`
      UPDATE outbox_event
         SET claimed_at = NULL,
             last_error = ${String((err as Error)?.message ?? err).slice(0, 500)},
             available_at = now() + ${backoffMs} * interval '1 millisecond',
             parked_at = ${parked ? sql`now()` : sql`NULL`}
       WHERE id = ${row.id}`;
    log.error({ err, attempts: row.attempts, parked }, 'dispatch failed');
    metrics.increment(parked ? 'outbox.parked' : 'outbox.dispatch_failed', { queue: row.queue });
    return parked ? 'parked' : 'retry';
  }
}

export function startOutboxPoller(sql: Sql, known: ReadonlySet<string>, dispatch: Dispatch) {
  let stopped = false;
  let ticking = false;              // no overlapping ticks in one process
  const log = logger.child({ component: 'outbox' });

  async function tick() {
    const rows = await claim(sql);
    for (const row of rows) await settleRow(sql, row, known, dispatch);
    if (rows.length > 0) log.debug({ n: rows.length }, 'dispatched');
  }

  // Lag is the signal that matters: rows waiting, and the age of the oldest. Alert on the
  // age, not the count — 3 rows stuck for an hour is an incident, 5,000 rows one second old
  // is a busy Saturday.
  async function reportLag() {
    const [row] = await sql<{ pending: number; oldest_seconds: number; parked: number }[]>`
      SELECT count(*) FILTER (WHERE dispatched_at IS NULL AND parked_at IS NULL)::int AS pending,
             COALESCE(EXTRACT(epoch FROM now() - min(available_at)
                      FILTER (WHERE dispatched_at IS NULL AND parked_at IS NULL AND available_at <= now())), 0)::int AS oldest_seconds,
             count(*) FILTER (WHERE parked_at IS NOT NULL)::int AS parked
        FROM outbox_event
       WHERE created_at > now() - interval '2 days'`;
    metrics.gauge('outbox.pending', row?.pending ?? 0);
    metrics.gauge('outbox.oldest_seconds', row?.oldest_seconds ?? 0);
    metrics.gauge('outbox.parked', row?.parked ?? 0);
  }

  const loop = setInterval(() => {
    if (stopped || ticking) return;
    ticking = true;
    tick()
      .catch((err) => log.error({ err }, 'outbox tick failed'))
      .finally(() => { ticking = false; });
  }, TICK_MS);

  const lagLoop = setInterval(() => {
    reportLag().catch((err) => log.error({ err }, 'outbox lag probe failed'));
  }, 10_000);

  return async function stop() {
    stopped = true;
    clearInterval(loop);
    clearInterval(lagLoop);
    while (ticking) await new Promise((r) => setTimeout(r, 25));
    await tick(); // final drain
  };
}
