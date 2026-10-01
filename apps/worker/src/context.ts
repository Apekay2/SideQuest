// apps/worker/src/context.ts
// What every job receives. The worker connects as sidequest_worker: RLS applies to it like
// any other role (0003, 0006 §7), it simply has broader policies than a user and no reach at
// all into kyc_case.

import type { Redis } from 'ioredis';
import type { Sql, Tx } from '@sidequest/db';
import type { Config } from '@sidequest/config';
import type { IssuerPort } from '@sidequest/domain/card/issuer.port';
import type { MpesaPort } from '@sidequest/domain/rails/mpesa.port';
import type { SmsPort, PushPort } from '@sidequest/adapters';
import { ledgerBalance, enqueueOutbox } from '@sidequest/db';
import type { Logger } from '@sidequest/observability';

export interface WorkerDeps {
  cfg: Config;
  sql: Sql;
  redis: Redis;
  issuer: IssuerPort;
  mpesa: MpesaPort;
  sms: SmsPort;
  push: PushPort;
}

export interface JobContext {
  deps: WorkerDeps;
  log: Logger;
  /** The outbox row this run came from, for idempotency keys that must be stable per job. */
  outboxId: string;
}

export type Handler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;

/** Realtime fan-out on the channel the API's WebSocket server subscribes to. */
export async function publish(deps: WorkerDeps, accountId: string | null | undefined, event: string, data: Record<string, unknown>) {
  if (!accountId) return;
  await deps.redis.publish(`u:${accountId}`, JSON.stringify({ event, data, at: new Date().toISOString() }));
}

/** Schedule a follow-up through the outbox, so a retry or a timer is as durable as the job. */
export async function later(tx: Tx, queue: string, payload: Record<string, unknown>, delaySeconds = 0) {
  await enqueueOutbox(tx, queue, payload, { delaySeconds });
}

/** The escrow balance for one errand, from the ledger. The mirror column is never trusted. */
export async function escrowBalance(tx: Tx, errandId: string, requesterId: string): Promise<number> {
  return ledgerBalance(tx, { account: 'escrow_hold', ownerId: requesterId, errandId });
}

/**
 * Bring the escrow mirror row in line with the ledger after a posting that touched escrow.
 * Reads are served from the mirror; reconciliation asserts they agree.
 */
export async function syncEscrowMirror(tx: Tx, errandId: string, requesterId: string, released = false) {
  const bal = await escrowBalance(tx, errandId, requesterId);
  await tx`UPDATE escrow SET held_cents = ${bal},
                              released_at = CASE WHEN ${released} THEN COALESCE(released_at, now()) ELSE released_at END
            WHERE errand_id = ${errandId}`;
  return bal;
}

export function str(p: Record<string, unknown>, k: string): string {
  const v = p[k];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`payload.${k} missing`);
  return v;
}
