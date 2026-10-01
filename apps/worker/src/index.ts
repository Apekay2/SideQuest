// apps/worker/src/index.ts
// Worker entrypoint: outbox poller, BullMQ consumers, and the scheduled jobs (nightly
// reconciliation, retention). No HTTP surface.

import { config, redactedConfig } from '@sidequest/config';
import { assertMarketsConsistent } from '@sidequest/domain/money/currency';
import { logger } from '@sidequest/observability';
import { buildWorkerDeps, startQueues } from './runtime.js';
import { reconcile } from './jobs/reconcile.job.js';
import { retention } from './jobs/retention.js';

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
      page: async (f) => logger.fatal({ findings: f }, 'RECONCILIATION PAGE'),
      ticket: async (f) => logger.error({ findings: f }, 'reconciliation ticket'),
    }));
  }
  void once(`retention:${now.toISOString().slice(0, 13)}`, 3600, () => retention(deps.sql, deps.storage));
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
