// apps/worker/src/outbox-poller.ts
// Moves committed outbox rows into BullMQ. This is the only bridge between the database
// and the queue, which is what makes "enqueue inside a transaction" honest.
//
// CORRECTED (panel review, finding P-3). The previous version set `dispatched_at = now()`
// in the same statement that read the batch, and enqueued afterwards. Everything between
// that commit and the `queue.add` was an at-most-once window: a pod restart, an OOM kill, a
// Redis blip or an unknown queue name silently dropped the job for good. The rows dropped
// that way are `card.load` (a runner waiting in a market for a card that never loads),
// `errand.settled` (a runner never paid) and `notify`. A transactional outbox that loses
// rows is worse than no outbox, because everything upstream is written trusting it.
//
// Now: claim with a lease, enqueue, then mark dispatched. At-least-once, which BullMQ's
// `jobId` dedupe turns back into effectively-once. A claim whose lease expires is retried;
// a row that fails repeatedly is parked for a human instead of being retried forever.

import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { Db } from '@sidequest/db';
import { logger } from '@sidequest/observability';
import { metrics } from '@sidequest/observability';

const TICK_MS = 250;
const BATCH = 100;
const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 10;

// Requires migration 0004: ALTER TABLE outbox_event
//   ADD COLUMN claimed_at timestamptz, ADD COLUMN attempts int NOT NULL DEFAULT 0,
//   ADD COLUMN last_error text, ADD COLUMN parked_at timestamptz;
// and the partial index on (available_at) WHERE dispatched_at IS NULL AND parked_at IS NULL.

export function startOutboxPoller(db: Db, queues: Record<string, Queue>) {
  let stopped = false;
  let ticking = false;              // no overlapping ticks in one process
  const log = logger.child({ component: 'outbox' });

  async function tick() {
    // Claim: take a lease rather than declaring the row done. SKIP LOCKED still lets several
    // worker instances drain the same table without contention.
    const rows = await db.execute<{ id: string; queue: string; payload: unknown; attempts: number }>(sql`
      UPDATE outbox_event
         SET claimed_at = now(), attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM outbox_event
          WHERE dispatched_at IS NULL
            AND parked_at IS NULL
            AND available_at <= now()
            AND (claimed_at IS NULL OR claimed_at < now() - ${LEASE_MS} * interval '1 millisecond')
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT ${BATCH})
      RETURNING id, queue, payload, attempts
    `);

    for (const row of rows) {
      const queue = queues[row.queue];

      // An unknown queue name is a deploy-order bug, not a transient fault. Park it so it is
      // visible in the ops console and countable in an alert, rather than logged once and
      // forgotten. It used to be marked dispatched, which meant "silently deleted".
      if (!queue) {
        await db.execute(sql`
          UPDATE outbox_event SET parked_at = now(), last_error = 'unknown queue'
           WHERE id = ${row.id}`);
        log.error({ queue: row.queue, id: row.id }, 'unknown queue, row parked');
        metrics.increment('outbox.parked', { reason: 'unknown_queue' });
        continue;
      }

      try {
        await queue.add(row.queue, row.payload, {
          jobId: `outbox:${row.id}`,           // dedupes a redelivered claim
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 1000,
          removeOnFail: false,
        });
        // Only now is the row done. A crash before this line means the lease expires and the
        // row is redelivered; `jobId` makes the duplicate a no-op.
        await db.execute(sql`
          UPDATE outbox_event SET dispatched_at = now() WHERE id = ${row.id}`);
      } catch (err) {
        const parked = row.attempts >= MAX_ATTEMPTS;
        await db.execute(sql`
          UPDATE outbox_event
             SET claimed_at = NULL,
                 last_error = ${String((err as Error)?.message ?? err).slice(0, 500)},
                 parked_at = ${parked ? sql`now()` : sql`NULL`}
           WHERE id = ${row.id}`);
        log.error({ err, id: row.id, attempts: row.attempts, parked }, 'enqueue failed');
        metrics.increment(parked ? 'outbox.parked' : 'outbox.enqueue_failed', { queue: row.queue });
      }
    }
    if (rows.length > 0) log.debug({ n: rows.length }, 'dispatched');
  }

  // Lag is the signal that matters: rows waiting, and the age of the oldest. Alert on the
  // age, not the count — 3 rows stuck for an hour is an incident, 5,000 rows one second old
  // is a busy Saturday.
  async function reportLag() {
    const [row] = await db.execute<{ pending: number; oldest_seconds: number; parked: number }>(sql`
      SELECT count(*) FILTER (WHERE dispatched_at IS NULL AND parked_at IS NULL) AS pending,
             COALESCE(EXTRACT(epoch FROM now() - min(available_at))
                      FILTER (WHERE dispatched_at IS NULL AND parked_at IS NULL), 0) AS oldest_seconds,
             count(*) FILTER (WHERE parked_at IS NOT NULL) AS parked
        FROM outbox_event
       WHERE created_at > now() - interval '2 days'
    `);
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
