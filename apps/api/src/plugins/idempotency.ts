// apps/api/src/plugins/idempotency.ts
// 04-api.md: every POST that moves money or creates a resource requires an Idempotency-Key
// (UUID v4), and the stored response is replayed for 24 hours.
//
// The key is claimed BEFORE the handler runs (an INSERT on the primary key, so two concurrent
// retries cannot both proceed) and the response is stored after. A retry of a request still
// in flight gets 409 rather than running twice. A key reused with a different body is a
// client bug and gets 409 IDEMPOTENCY_CONFLICT rather than the wrong replay.

import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withActor } from '@sidequest/db';
import { AppError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default fp(async function idempotency(app: FastifyInstance) {
  const { sql } = app.deps;

  app.decorate('idempotent', async (req, reply) => {
    const actor = req.actor;
    if (!actor) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in first');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !UUID.test(key)) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (UUID) is required');
    }
    const route = `${req.method} ${req.routeOptions.url}`;
    const hash = createHash('sha256')
      .update(route).update('\0').update(req.url).update('\0').update(JSON.stringify(req.body ?? null))
      .digest('hex');

    const outcome = await withActor(sql, actor, async (tx) => {
      const inserted = await tx`
        INSERT INTO idempotency_key (account_id, key, route, request_hash)
        VALUES (${actor.id}, ${key}, ${route}, ${hash})
        ON CONFLICT (account_id, key) DO NOTHING
        RETURNING key`;
      if (inserted.length === 1) return { kind: 'fresh' as const };
      const [prior] = await tx<{ request_hash: string; status_code: number | null; response: unknown; created_at: Date }[]>`
        SELECT request_hash, status_code, response, created_at FROM idempotency_key
         WHERE account_id = ${actor.id} AND key = ${key}`;
      return { kind: 'prior' as const, prior: prior! };
    });

    if (outcome.kind === 'fresh') {
      req.idempotency = { key, hash, replayed: false };
      return;
    }
    const { prior } = outcome;
    if (Date.now() - prior.created_at.getTime() > 24 * 3600_000) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key has expired; use a new one');
    }
    if (prior.request_hash !== hash) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different request');
    }
    if (prior.status_code === null) {
      throw new AppError(409, 'IDEMPOTENCY_IN_FLIGHT', 'The original request is still being processed');
    }
    req.idempotency = { key, hash, replayed: true };
    reply.header('Idempotent-Replayed', 'true');
    // Returning the reply from a preHandler ends the request with the stored response.
    return reply.code(prior.status_code).send(prior.response ?? undefined);
  });

  // Store the outcome. A 5xx releases the key so the client's retry runs for real; any other
  // outcome, including a 4xx, is the answer to that key for 24 hours.
  app.addHook('onSend', async (req, reply, payload) => {
    const idem = req.idempotency;
    if (!idem || idem.replayed || !req.actor) return payload;
    const actor = req.actor;
    try {
      if (reply.statusCode >= 500) {
        await withActor(sql, actor, (tx) => tx`
          DELETE FROM idempotency_key WHERE account_id = ${actor.id} AND key = ${idem.key}`);
      } else {
        let body: unknown = null;
        if (typeof payload === 'string' && payload.length > 0) {
          try { body = JSON.parse(payload); } catch { body = null; }
        }
        await withActor(sql, actor, (tx) => tx`
          UPDATE idempotency_key SET status_code = ${reply.statusCode}, response = ${tx.json(body as never)}
           WHERE account_id = ${actor.id} AND key = ${idem.key}`);
      }
    } catch (err) {
      req.log.error({ err }, 'failed to record idempotent response');
    }
    return payload;
  });
});
