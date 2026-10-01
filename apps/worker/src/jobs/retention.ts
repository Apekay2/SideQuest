// apps/worker/src/jobs/retention.ts
// Retention, as policy in code (01-architecture §1.8, 07-security DPA section):
//   - location points kept 30 days, then nulled; the res-9 cell stays for demand analysis
//   - dispatched outbox rows kept 14 days; parked rows never auto-deleted (someone's money)
//   - idempotency keys kept 24 hours past their replay window

import type { Sql } from '@sidequest/db';
import { logger, metrics } from '@sidequest/observability';

export async function retention(sql: Sql) {
  const points = await sql`
    UPDATE runner_location_history SET point = NULL
     WHERE point IS NOT NULL AND recorded_at < now() - interval '30 days'`;
  const outbox = await sql`
    DELETE FROM outbox_event WHERE dispatched_at IS NOT NULL AND dispatched_at < now() - interval '14 days'`;
  const idem = await sql`DELETE FROM idempotency_key WHERE created_at < now() - interval '48 hours'`;
  metrics.gauge('retention.points_nulled', points.count);
  logger.info({ points: points.count, outbox: outbox.count, idempotency: idem.count }, 'retention pass');
}
