// apps/worker/src/jobs/retention.ts
// Retention, as policy in code (01-architecture §1.8, 07-security DPA section):
//   - location points kept 30 days, then nulled; the res-9 cell stays for demand analysis
//   - dispatched outbox rows kept 14 days; parked rows never auto-deleted (someone's money)
//   - idempotency keys kept 24 hours past their replay window
//   - rejected/expired KYC 90 days after review, errand photos 2 years, chat 1 year, never while
//     an errand is live or disputed (app_retention_purge, 0011); then their stored objects

import { enqueueStorageDeletes, type Sql } from '@sidequest/db';
import type { StoragePort } from '@sidequest/adapters';
import { logger, metrics } from '@sidequest/observability';
import type { Handler } from '../context.js';

/**
 * Delete stored objects now, best effort. Every caller has already recorded the same keys
 * for the durable `storage.delete` job in the transaction that deleted their rows, so a
 * failure here only means the job finishes the work.
 */
export async function deleteNow(storage: StoragePort, keys: readonly string[], reason: string): Promise<number> {
  let failed = 0;
  for (const key of keys) {
    try { await storage.delete(key); } catch { failed += 1; }
  }
  if (failed) metrics.increment('storage.delete_deferred', { reason }, failed);
  return failed;
}

/** The durable retry: throws while any key still fails, so the outbox retries and then parks. */
export const storageDelete: Handler = async (payload, ctx) => {
  const keys = Array.isArray(payload.keys) ? payload.keys.filter((k): k is string => typeof k === 'string') : [];
  const reason = typeof payload.reason === 'string' ? payload.reason : 'retry';
  const left: string[] = [];
  for (const key of keys) {
    try { await ctx.deps.storage.delete(key); } catch { left.push(key); }
  }
  if (left.length) throw new Error(`${left.length} of ${keys.length} stored objects still not deleted (${reason})`);
};

export async function retention(sql: Sql, storage: StoragePort) {
  const points = await sql`
    UPDATE runner_location_history SET point = NULL
     WHERE point IS NOT NULL AND recorded_at < now() - interval '30 days'`;
  const outbox = await sql`
    DELETE FROM outbox_event WHERE dispatched_at IS NOT NULL AND dispatched_at < now() - interval '14 days'`;
  const idem = await sql`DELETE FROM idempotency_key WHERE created_at < now() - interval '48 hours'`;
  // The purge deletes the rows that name the stored objects; the deletion job is written in the
  // same transaction, so no failure after it can leave an object with nothing pointing at it.
  const keys = await sql.begin(async (tx) => {
    const [purge] = await tx<{ keys: string[] }[]>`SELECT app_retention_purge() AS keys`;
    await enqueueStorageDeletes(tx, purge!.keys, 'retention');
    return purge!.keys;
  });
  const failed = await deleteNow(storage, keys, 'retention');
  metrics.gauge('retention.points_nulled', points.count);
  logger[failed ? 'warn' : 'info']({ points: points.count, outbox: outbox.count, idempotency: idem.count,
    objects: keys.length, objects_failed: failed }, 'retention pass');
}
