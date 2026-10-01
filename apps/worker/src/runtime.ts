// apps/worker/src/runtime.ts
// Building the worker's dependencies, and running handlers — either inline (tests, the drain
// CLI) or through BullMQ (production). Both paths go through the same claim/settle code in
// outbox-poller.ts and the same handler registry.

import { Redis } from 'ioredis';
import { Queue, Worker, type Job } from 'bullmq';
import type { Config } from '@sidequest/config';
import { createDb, enqueueOutbox, type Sql } from '@sidequest/db';
import { MockIssuer, FakeMpesa, Daraja, ConsoleSms, AfricasTalkingSms, ConsolePush, ExpoPush, LocalStorage, R2Storage } from '@sidequest/adapters';
import { logger } from '@sidequest/observability';
import type { WorkerDeps, JobContext } from './context.js';
import { HANDLERS } from './handlers.js';
import { claim, settleRow, startOutboxPoller, type OutboxRow } from './outbox-poller.js';

export const QUEUE = 'sidequest';

export function buildWorkerDeps(cfg: Config, over: Partial<WorkerDeps> = {}): WorkerDeps {
  const url = cfg.WORKER_DATABASE_URL;
  if (!url) throw new Error('WORKER_DATABASE_URL is required to run the worker');
  const sql = over.sql ?? createDb(url, { max: 10, application: 'sidequest-worker' });
  const redis = over.redis ?? new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  // The fake rail delivers its callbacks exactly where the webhook route would: an outbox row
  // for mpesa.callback, so dev exercises the production parsing and matching path.
  const deliverToOutbox = (s: Sql) => async (kind: 'stk' | 'result', body: unknown) => {
    await s.begin((tx) => enqueueOutbox(tx, 'mpesa.callback', { kind, body: body as Record<string, unknown> }));
  };
  return {
    cfg,
    sql,
    redis,
    // In development the mock spends each load at once, as a runner paying the exact stall
    // total would; tests drive spending explicitly with simulateSpend.
    issuer: over.issuer ?? new MockIssuer(redis, { autoSpend: cfg.NODE_ENV === 'development' }),
    mpesa: over.mpesa ?? (cfg.DARAJA_DRIVER === 'fake'
      ? new FakeMpesa(deliverToOutbox(sql), cfg.NODE_ENV === 'test' ? 0 : 800)
      : new Daraja({
          env: cfg.DARAJA_ENV, consumerKey: cfg.DARAJA_CONSUMER_KEY!, consumerSecret: cfg.DARAJA_CONSUMER_SECRET!,
          shortcode: cfg.DARAJA_SHORTCODE!, passkey: cfg.DARAJA_PASSKEY!, initiator: cfg.DARAJA_B2C_INITIATOR!,
          securityCredential: cfg.DARAJA_B2C_CREDENTIAL!, callbackBase: cfg.DARAJA_CALLBACK_BASE!,
          callbackToken: cfg.DARAJA_CALLBACK_TOKEN!,
        })),
    sms: over.sms ?? (cfg.SMS_DRIVER === 'console'
      ? new ConsoleSms()
      : new AfricasTalkingSms({ username: cfg.AT_USERNAME!, apiKey: cfg.AT_API_KEY!, senderId: cfg.AT_SENDER_ID, sandbox: cfg.NODE_ENV !== 'production' })),
    push: over.push ?? (cfg.PUSH_DRIVER === 'expo' ? new ExpoPush({ accessToken: cfg.EXPO_ACCESS_TOKEN }) : new ConsolePush()),
    storage: over.storage ?? (cfg.STORAGE_DRIVER === 'local'
      ? new LocalStorage(cfg.STORAGE_LOCAL_DIR, cfg.API_PUBLIC_ORIGIN, cfg.COOKIE_SECRET)
      : new R2Storage({ accountId: cfg.R2_ACCOUNT_ID!, accessKeyId: cfg.R2_ACCESS_KEY_ID!,
          secretAccessKey: cfg.R2_SECRET_ACCESS_KEY!, bucket: cfg.R2_BUCKET! })),
  };
}

const KNOWN = new Set(Object.keys(HANDLERS));

export async function runHandler(deps: WorkerDeps, row: OutboxRow): Promise<void> {
  const handler = HANDLERS[row.queue];
  if (!handler) throw new Error(`no handler for ${row.queue}`);
  const ctx: JobContext = { deps, log: logger.child({ queue: row.queue, outbox: row.id }), outboxId: row.id };
  await handler(row.payload, ctx);
}

/**
 * Run every due outbox row inline until none are left (or `maxRounds` passes). Delays are
 * honoured unless `ignoreDelay`, which lets a test fast-forward a timer it chose to trigger.
 */
export async function drain(deps: WorkerDeps, opts: { ignoreDelay?: boolean; maxRounds?: number; only?: string[] } = {}) {
  const ran: string[] = [];
  for (let round = 0; round < (opts.maxRounds ?? 50); round++) {
    const rows = await claim(deps.sql, { ignoreDelay: opts.ignoreDelay });
    const due = opts.only ? rows.filter((r) => opts.only!.includes(r.queue)) : rows;
    // Rows claimed but filtered out are released at once rather than waiting out the lease.
    for (const r of rows) if (!due.includes(r)) await deps.sql`UPDATE outbox_event SET claimed_at = NULL, attempts = attempts - 1 WHERE id = ${r.id}`;
    if (due.length === 0) return ran;
    for (const row of due) {
      const outcome = await settleRow(deps.sql, row, KNOWN, (r) => runHandler(deps, r));
      ran.push(`${row.queue}:${outcome}`);
    }
  }
  return ran;
}

/** Production: poller → BullMQ → workers. */
export function startQueues(deps: WorkerDeps, concurrency = 8) {
  const connection = deps.redis;
  const queue = new Queue(QUEUE, { connection });

  const stopPoller = startOutboxPoller(deps.sql, KNOWN, async (row) => {
    await queue.add(row.queue, { outboxId: row.id, payload: row.payload }, {
      // Dedupes a redelivered claim. Keyed on the event's uuid, not the bigserial id: a restored
      // or rebuilt database reissues ids from 1, and BullMQ would silently drop those as seen.
      jobId: `outbox-${row.eventId ?? row.id}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    });
  });

  const worker = new Worker(QUEUE, async (job: Job<{ outboxId: string; payload: Record<string, unknown> }>) => {
    await runHandler(deps, { id: job.data.outboxId, queue: job.name, payload: job.data.payload, attempts: job.attemptsMade });
  }, { connection: deps.redis.duplicate(), concurrency });

  // A job that exhausted its BullMQ retries is written back to its outbox row as parked, so
  // it is visible to reconciliation and the ops console rather than sitting in Redis alone.
  worker.on('failed', (job, err) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    deps.sql`UPDATE outbox_event SET parked_at = now(), last_error = ${String(err?.message ?? err).slice(0, 500)}
              WHERE id = ${job.data.outboxId}`.catch((e) => logger.error({ err: e }, 'could not park failed job'));
  });

  return async function stop() {
    await stopPoller();
    await worker.close();
    await queue.close();
  };
}
