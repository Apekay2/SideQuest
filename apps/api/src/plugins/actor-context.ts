// apps/api/src/plugins/actor-context.ts
// Binds every database transaction to the authenticated actor, so RLS (0003_rls.sql) has
// something to enforce. This plugin is what makes the policies real; without it every policy
// evaluates app_actor() = NULL and the API returns zero rows for everything — which is the
// correct failure direction, and is asserted by a test.
//
// Two rules that are not negotiable:
//   1. SET LOCAL, never SET. Under PgBouncer transaction pooling a plain SET outlives the
//      request and the next borrower of that connection inherits the previous actor.
//   2. set_config(name, value, true) with bound parameters. Never string-interpolate the
//      actor into SQL — a GUC assignment is a SQL statement like any other.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';

export interface Actor {
  id: string;
  role: 'requester' | 'runner' | 'staff';
  tier: 0 | 1 | 2 | 3;
  entitlements: readonly string[];
  sessionId: string;
}

const ENT_RE = /^[a-z0-9_.]{1,48}$/;

/** Defence in depth: entitlements travel into a GUC as a comma-joined string, so a value
 *  containing a comma would forge a second entitlement. Reject rather than escape. */
function encodeEntitlements(ents: readonly string[]): string {
  const clean = ents.filter((e) => ENT_RE.test(e));
  if (clean.length !== ents.length) throw new Error('Malformed entitlement in session claims');
  return clean.join(',');
}

export default fp(async function actorContext(app: FastifyInstance) {
  /**
   * The only sanctioned way to touch the database inside a request. `app.db.transaction` is
   * deliberately NOT exposed to route code any more (see the shadowing below) — an
   * unscoped transaction is an unauthenticated one.
   */
  app.decorate('tx', async function tx<T>(
    req: FastifyRequest,
    fn: (t: any) => Promise<T>,
    opts: { discovery?: boolean; otpChallengeId?: string } = {},
  ): Promise<T> {
    const actor = req.actor as Actor | undefined;

    return app.dbRaw.transaction(async (t: any) => {
      if (actor) {
        await t.execute(sql`SELECT set_config('app.actor_id',      ${actor.id},   true)`);
        await t.execute(sql`SELECT set_config('app.actor_role',    ${actor.role}, true)`);
        await t.execute(sql`SELECT set_config('app.entitlements',
                              ${encodeEntitlements(actor.entitlements)}, true)`);
        await t.execute(sql`SELECT set_config('app.session_id',    ${actor.sessionId}, true)`);
      }
      // Purpose-scoped widenings. Both are single-statement in practice and both are logged.
      if (opts.discovery) {
        await t.execute(sql`SELECT set_config('app.discovery', 'on', true)`);
        req.log.debug({ actor: actor?.id }, 'discovery scope opened');
      }
      if (opts.otpChallengeId) {
        await t.execute(sql`SELECT set_config('app.otp_challenge_id', ${opts.otpChallengeId}, true)`);
      }
      // Statement timeout inside the request path: a policy subquery on a bad plan must not
      // hold a pooled connection open. Money transactions raise it explicitly.
      await t.execute(sql`SET LOCAL statement_timeout = '5s'`);
      await t.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '10s'`);
      return fn(t);
    });
  });

  // Shadow the raw handle so `app.db.transaction(...)` in a route is a type error rather than
  // a silent RLS bypass. Anything that genuinely needs an unscoped transaction (migrations,
  // reconciliation) runs in the worker under sidequest_worker, not here.
  app.decorate('db', new Proxy({}, {
    get(_t, prop) {
      if (prop === 'transaction') {
        throw new Error('Use app.tx(req, fn) — a bare transaction has no actor and RLS will return nothing');
      }
      return (app.dbRaw as any)[prop];
    },
  }));
});
