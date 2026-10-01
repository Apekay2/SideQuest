// apps/api/src/plugins/actor-context.ts
// Binds every database transaction to the authenticated actor, so RLS (0003_rls.sql, 0006)
// has something to enforce. This plugin is what makes the policies real; without it every
// policy evaluates app_actor() = NULL and the API returns zero rows for everything — which is
// the correct failure direction, and is asserted by a test.
//
// Two rules that are not negotiable:
//   1. SET LOCAL, never SET. Under PgBouncer transaction pooling a plain SET outlives the
//      request and the next borrower of that connection inherits the previous actor.
//   2. set_config(name, value, true) with bound parameters. Never string-interpolate the
//      actor into SQL — a GUC assignment is a SQL statement like any other.
// Both live in packages/db withActor(), which the worker and the tests share.
//
// There is no raw pool on the Fastify instance at all. The old version shadowed
// `app.db.transaction` with a throwing proxy; here the pool is simply not reachable from a
// route, so an unscoped transaction is not a runtime error but an impossibility.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withActor, type Tx, type ScopeOptions } from '@sidequest/db';
import { AppError } from './errors.js';

export default fp(async function actorContext(app: FastifyInstance) {
  const { sql, opsSql, redis } = app.deps;

  app.decorate('tx', function tx<T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>, opts: ScopeOptions = {}): Promise<T> {
    if (opts.discovery) req.log.debug({ actor: req.actor?.id }, 'discovery scope opened');
    return withActor(sql, req.actor ?? null, fn, opts).catch((err: { code?: string }) => {
      // Two approvals racing under SERIALIZABLE: one loses with 40001. That is a retryable
      // conflict for the client, not a server fault.
      if (err?.code === '40001' || err?.code === '40P01') {
        throw new AppError(409, 'CONCURRENT_UPDATE', 'Someone else changed this at the same moment. Try again.');
      }
      throw err;
    });
  });

  app.decorate('opsTx', function opsTx<T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>): Promise<T> {
    if (!req.actor || req.actor.role !== 'staff') throw new AppError(403, 'FORBIDDEN', 'Staff only');
    return withActor(opsSql, req.actor, fn);
  });

  app.decorate('audit', async function audit(
    req: FastifyRequest,
    entry: { action: string; subject: string; meta?: Record<string, unknown> },
    tx?: Tx,
  ) {
    const write = (t: Tx) => t`
      INSERT INTO audit_log (actor_id, action, subject, meta)
      VALUES (${req.actor?.id ?? null}, ${entry.action}, ${entry.subject},
              ${t.json({ ...(entry.meta ?? {}), ip: req.trustedIp, request_id: req.id } as never)})`;
    if (tx) await write(tx);
    else await withActor(sql, req.actor ?? null, write);
  });

  // Realtime fan-out. The websocket server subscribes to u:{accountId}; so does any other API
  // replica, so an event raised on one pod reaches a socket held by another.
  app.decorate('publish', async function publish(accountId: string, event: string, data: Record<string, unknown>) {
    await redis.publish(`u:${accountId}`, JSON.stringify({ event, data, at: new Date().toISOString() }));
  });
});
