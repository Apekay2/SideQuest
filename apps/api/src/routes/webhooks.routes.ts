// apps/api/src/routes/webhooks.routes.ts
// Inbound webhooks (04-api.md). Handlers do one thing: check the source, check the signature
// where the provider signs, and hand the body to the worker through the outbox. They never
// contain business logic and they always answer 200 — a 500 to Safaricom is a retry storm.
//
// The app role has no access to mpesa_event at all (0003: "there is no path from a user
// request to mpesa_event"). The body travels in an outbox row; the worker, as
// sidequest_worker, records it and acts on it. A forged confirmation that somehow passed the
// source check still has to survive the worker matching it to a payment it initiated.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withActor, enqueueOutbox } from '@sidequest/db';
import { ipInCidrs } from '@sidequest/adapters';
import { metrics } from '@sidequest/observability';

export default async function webhookRoutes(app: FastifyInstance) {
  const { cfg, sql } = app.deps;

  const expected = cfg.DARAJA_CALLBACK_TOKEN ? Buffer.from(cfg.DARAJA_CALLBACK_TOKEN) : null;

  /** Why a callback is refused, or null if it may proceed. */
  function refusal(req: FastifyRequest): 'driver' | 'token' | 'source' | null {
    // The fake driver delivers in-process in the worker and never calls these routes, so with
    // it configured there is nothing legitimate to accept — an open route would let anyone
    // post confirmations into a dev or staging money path.
    if (cfg.DARAJA_DRIVER === 'fake' || !expected) return 'driver';
    const got = Buffer.from(String((req.params as { token?: string }).token ?? ''));
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return 'token';
    if (!ipInCidrs(req.trustedIp, cfg.DARAJA_SOURCE_CIDRS)) return 'source';
    return null;
  }

  const daraja = (kind: 'stk' | 'result' | 'timeout') => async (req: FastifyRequest) => {
    const why = refusal(req);
    if (why) {
      metrics.increment('webhook.dropped', { source: 'daraja', reason: why });
      req.log.warn({ ip: req.trustedIp, reason: why }, 'daraja callback dropped');
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }
    await withActor(sql, null, (tx) => enqueueOutbox(tx, 'mpesa.callback', { kind, body: req.body as Record<string, unknown> }));
    metrics.increment('webhook.accepted', { source: 'daraja', kind });
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  };

  app.post('/webhooks/daraja/:token/stk', daraja('stk'));
  app.post('/webhooks/daraja/:token/b2c/result', daraja('result'));
  app.post('/webhooks/daraja/:token/timeout', daraja('timeout'));

  // Card issuer events. Signed with ISSUER_WEBHOOK_SECRET over the RAW body — re-serialised
  // JSON is not byte-identical to what the issuer signed — so this route parses its own body.
  // An unverified card webhook can fake a load, which is why env.ts refuses a live issuer
  // without the secret.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      try { done(null, { raw: body as string, json: JSON.parse(body as string) as unknown }); }
      catch { done(null, { raw: body as string, json: null }); }
    });
    scope.post('/webhooks/issuer/authorization', async (req, reply) => {
      const { raw, json } = (req.body ?? { raw: '', json: null }) as { raw: string; json: unknown };
      const secret = cfg.ISSUER_WEBHOOK_SECRET;
      if (!secret && cfg.NODE_ENV === 'production') return reply.code(200).send({ ok: true });
      if (secret) {
        const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
        const got = Buffer.from(String(req.headers['x-issuer-signature'] ?? ''));
        if (want.length !== got.length || !timingSafeEqual(want, got)) {
          metrics.increment('webhook.dropped', { source: 'issuer', reason: 'signature' });
          return reply.code(200).send({ ok: true });
        }
      }
      if (json && typeof json === 'object') {
        await withActor(sql, null, (tx) => enqueueOutbox(tx, 'issuer.event', { body: json as Record<string, unknown> }));
      }
      return reply.code(200).send({ ok: true });
    });
  });
}
