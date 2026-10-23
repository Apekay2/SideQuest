// apps/worker/src/index.ts
// Worker entrypoint: outbox poller, BullMQ consumers, and the scheduled jobs (nightly
// reconciliation, retention). No HTTP surface.

import { config, redactedConfig } from '@sidequest/config';
import { assertMarketsConsistent } from '@sidequest/domain/money/currency';
import { logger } from '@sidequest/observability';
import { buildWorkerDeps, startQueues } from './runtime.js';
import { reconcile } from './jobs/reconcile.job.js';
import { retention } from './jobs/retention.js';
import { watchdog } from './jobs/safety.js';
import { expireUnansweredPushes } from './jobs/payments.js';

const cfg = config();
assertMarketsConsistent();
logger.info({ config: redactedConfig(cfg) }, 'booting worker');

const deps = buildWorkerDeps(cfg);
const stop = startQueues(deps);

// Scheduled work is guarded by a Redis lock so that N worker replicas run it once.
async function once(name: string, ttlSeconds: number, fn: () => Promise<unknown>) {
  const ok = await deps.redis.set(`sched:${name}`, '1', 'EX', ttlSeconds, 'NX');
  if (ok) await fn().catch((err) => logger.error({ err, job: name }, 'scheduled job failed'));
}

const hourly = setInterval(() => {
  const now = new Date();
  // 03:00 Nairobi is 00:00 UTC.
  if (now.getUTCHours() === 0) {
    void once(`reconcile:${now.toISOString().slice(0, 10)}`, 86_400, () => reconcile({
      sql: deps.sql, issuer: deps.issuer,
      // Findings carry counts and sample ids; the alert carries the check names and counts.
      page: async (f) => deps.alert({ severity: 'page', title: `Reconciliation: ${f.length} check(s) failed`,
        data: Object.fromEntries(f.map((x) => [x.check, x.count])) }),
      ticket: async (f) => deps.alert({ severity: 'ticket', title: `Reconciliation: ${f.length} finding(s) to review`,
        data: Object.fromEntries(f.map((x) => [x.check, x.count])) }),
    }));
  }
  void once(`retention:${now.toISOString().slice(0, 13)}`, 3600, () => retention(deps.sql, deps.storage));
  // Every ten minutes (the key is the ISO time to the tens of minutes, "2026-10-23T09:1"):
  // errands stuck in a live state go to Legal Operations (jobs/safety.ts), and M-Pesa prompts
  // nobody answered are closed (jobs/payments.ts).
  const tenMinutes = now.toISOString().slice(0, 15);
  void once(`watchdog:${tenMinutes}`, 600, () => watchdog({ sql: deps.sql, alert: deps.alert }));
  void once(`pushes:${tenMinutes}`, 600, () => expireUnansweredPushes(deps));
}, 60_000);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    logger.info({ sig }, 'worker shutting down');
    clearInterval(hourly);
    await stop();
    await deps.sql.end({ timeout: 5 });
    deps.redis.disconnect();
    process.exit(0);
  });
}
