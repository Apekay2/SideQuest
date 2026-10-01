// packages/db/src/index.ts
// Database access. Plain SQL through postgres.js; the migrations in ../migrations are the
// schema, and there is no second copy of it here to drift.
//
// The one rule everything else depends on: application code reaches the database through
// `withActor`, which binds the actor to the transaction with SET LOCAL so the RLS policies
// in 0003/0006 have something to enforce. See apps/api/src/plugins/actor-context.ts.

import postgres from 'postgres';
import type { PostingGroup } from '@sidequest/domain/ledger/posting';

export type Sql = postgres.Sql<{ bigint: number }>;
export type Tx = postgres.TransactionSql<{ bigint: number }>;
/** Anything that can run a tagged query: a pool or a transaction. */
export type Q = Sql | Tx;

export function createDb(url: string, opts: { max?: number; application?: string } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    connection: { application_name: opts.application ?? 'sidequest' },
    // int8 → number. Every bigint in this schema is minor units or a serial id; both stay far
    // inside Number.MAX_SAFE_INTEGER, and a string amount would leak into arithmetic.
    types: {
      bigint: {
        to: 20, from: [20],
        serialize: (x: number | bigint) => x.toString(),
        parse: (x: string) => {
          const n = Number(x);
          if (!Number.isSafeInteger(n)) throw new Error(`int8 out of safe range: ${x}`);
          return n;
        },
      },
    },
  });
}

// ─────────────────────────────────────────────── actor binding

export interface ActorClaims {
  id: string;
  role: 'requester' | 'runner' | 'staff';
  entitlements: readonly string[];
  sessionId: string;
}

export interface ScopeOptions {
  /** Purpose-scoped widening for the runners-nearby query (0003 loc_discovery). */
  discovery?: boolean;
  otpChallengeId?: string;
  /** Set only after the OTP is verified, in the same transaction (0006 account_login). */
  loginMsisdn?: string;
  refreshHash?: string;
  sessionFamily?: string;
  isolation?: 'serializable';
  statementTimeout?: string;
}

const ENT_RE = /^[a-z0-9_.]{1,48}$/;

/** Entitlements travel into a GUC as a comma-joined string, so a value containing a comma
 *  would forge a second entitlement. Reject rather than escape. */
export function encodeEntitlements(ents: readonly string[]): string {
  const clean = ents.filter((e) => ENT_RE.test(e));
  if (clean.length !== ents.length) throw new Error('Malformed entitlement in session claims');
  return clean.join(',');
}

/**
 * Run `fn` in a transaction bound to `actor`. SET LOCAL via set_config(…, true) with bound
 * parameters: the setting dies with the transaction, so it cannot leak to the next borrower
 * of a pooled connection, and nothing is string-interpolated into SQL.
 */
export async function withActor<T>(
  sql: Sql,
  actor: ActorClaims | null,
  fn: (tx: Tx) => Promise<T>,
  opts: ScopeOptions = {},
): Promise<T> {
  const ents = actor ? encodeEntitlements(actor.entitlements) : '';
  return sql.begin(async (tx) => {
    if (opts.isolation === 'serializable') await tx`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
    if (actor) {
      await tx`SELECT set_config('app.actor_id', ${actor.id}, true),
                      set_config('app.actor_role', ${actor.role}, true),
                      set_config('app.entitlements', ${ents}, true),
                      set_config('app.session_id', ${actor.sessionId}, true)`;
    }
    if (opts.discovery) await tx`SELECT set_config('app.discovery', 'on', true)`;
    if (opts.otpChallengeId) await tx`SELECT set_config('app.otp_challenge_id', ${opts.otpChallengeId}, true)`;
    if (opts.loginMsisdn) await tx`SELECT set_config('app.login_msisdn', ${opts.loginMsisdn}, true)`;
    if (opts.refreshHash) await tx`SELECT set_config('app.refresh_hash', ${opts.refreshHash}, true)`;
    if (opts.sessionFamily) await tx`SELECT set_config('app.session_family', ${opts.sessionFamily}, true)`;
    await tx`SELECT set_config('statement_timeout', ${opts.statementTimeout ?? '5s'}, true)`;
    return fn(tx as Tx);
  }) as Promise<T>;
}

/** Narrow a scope's GUC mid-transaction, e.g. after the OTP check passes. */
export async function setScope(tx: Tx, name: 'app.login_msisdn' | 'app.actor_id' | 'app.actor_role' | 'app.entitlements' | 'app.session_id', value: string): Promise<void> {
  await tx`SELECT set_config(${name}, ${value}, true)`;
}

// ─────────────────────────────────────────────── ledger

/**
 * Write a domain posting group. The group has already been checked for balance in the domain;
 * the deferred triggers check it again at commit, as whoever owns them (0006 §1).
 */
export async function insertPostingGroup(tx: Tx, group: PostingGroup): Promise<string> {
  const [g] = await tx<{ id: string }[]>`
    INSERT INTO posting_group (errand_id, reason, currency)
    VALUES (${group.errandId}, ${group.reason}, ${group.currency})
    RETURNING id`;
  for (const p of group.postings) {
    await tx`
      INSERT INTO posting (group_id, account, owner_id, amount_cents, currency, fund_class)
      VALUES (${g!.id}, ${p.account}, ${p.ownerId}, ${p.amountCents}, ${group.currency}, ${p.fundClass})`;
  }
  return g!.id;
}

/** Current balance of one ledger account for one owner, optionally scoped to an errand. */
export async function ledgerBalance(
  q: Q, args: { account: string; ownerId: string | null; errandId?: string; currency?: string },
): Promise<number> {
  const [r] = await q<{ total: number }[]>`
    SELECT COALESCE(sum(p.amount_cents), 0)::bigint AS total
      FROM posting p JOIN posting_group g ON g.id = p.group_id
     WHERE p.account = ${args.account}
       AND p.owner_id IS NOT DISTINCT FROM ${args.ownerId}
       AND p.currency = ${args.currency ?? 'KES'}
       ${args.errandId ? q`AND g.errand_id = ${args.errandId}` : q``}`;
  return r!.total;
}

// ─────────────────────────────────────────────── outbox

export interface OutboxOptions {
  delaySeconds?: number;
  errandId?: string;
  actorId?: string;
}

/**
 * Commit a job with the data it concerns. The poller moves it to BullMQ afterwards; Redis
 * being down at this moment cannot lose it.
 */
export async function enqueueOutbox(tx: Tx, queue: string, payload: Record<string, unknown>, opts: OutboxOptions = {}): Promise<void> {
  const delay = opts.delaySeconds ?? 0;
  await tx`
    INSERT INTO outbox_event (queue, payload, available_at, errand_id, actor_id)
    VALUES (${queue}, ${tx.json(payload as postgres.JSONValue)},
            now() + make_interval(secs => ${delay}),
            ${opts.errandId ?? (typeof payload.errandId === 'string' ? payload.errandId : null)},
            ${opts.actorId ?? null})`;
}

export { postgres };
