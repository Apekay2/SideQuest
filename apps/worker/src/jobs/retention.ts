// apps/worker/src/jobs/retention.ts
// Retention, as policy in code (01-architecture §1.8, 07-security DPA section):
//   - location points kept 30 days, then nulled; the res-9 cell stays for demand analysis
//   - dispatched outbox rows kept 14 days; parked rows never auto-deleted (someone's money)
//   - idempotency keys kept 24 hours past their replay window
//   - rejected/expired KYC 90 days after review, errand photos 2 years, chat 1 year, never while
//     an errand is live or disputed (app_retention_purge, 0011); then their stored objects

import type { Sql } from '@sidequest/db';
import type { StoragePort } from '@sidequest/adapters';
import { logger, metrics } from '@sidequest/observability';

export async function retention(sql: Sql, storage: StoragePort) {
  const points = await sql`
    UPDATE runner_location_history SET point = NULL
     WHERE point IS NOT NULL AND recorded_at < now() - interval '30 days'`;
  const outbox = await sql`
    DELETE FROM outbox_event WHERE dispatched_at IS NOT NULL AND dispatched_at < now() - interval '14 days'`;
  const idem = await sql`DELETE FROM idempotency_key WHERE created_at < now() - interval '48 hours'`;
  const [purge] = await sql<{ keys: string[] }[]>`SELECT app_retention_purge() AS keys`;
  let failed = 0;
  for (const key of purge!.keys) {
    try { await storage.delete(key); } catch { failed++; }
  }
  metrics.gauge('retention.points_nulled', points.count);
  logger[failed ? 'error' : 'info']({ points: points.count, outbox: outbox.count, idempotency: idem.count,
    objects: purge!.keys.length, objects_failed: failed }, 'retention pass');
}
