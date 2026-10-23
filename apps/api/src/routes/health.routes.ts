// apps/api/src/routes/health.routes.ts
// Liveness answers "is the process up"; readiness answers "can it serve", checking the two
// shared dependencies 06-services.md §6.4 names. Metrics are internal-only in deployment
// (the load balancer does not route /health/metrics publicly).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { metrics } from '@sidequest/observability';
import { ipInCidrs } from '@sidequest/adapters';

/** Loopback and private ranges: where a scraper inside the cluster or VPC calls from. */
const PRIVATE = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'];

export default async function healthRoutes(app: FastifyInstance) {
  app.get('/health/live', async () => ({ ok: true }));

  app.get('/health/ready', async (_req, reply) => {
    const checks = await Promise.allSettled([
      app.deps.sql`SELECT 1`,
      app.deps.redis.ping(),
    ]);
    const [db, redis] = checks.map((c) => c.status === 'fulfilled');
    return reply.code(db && redis ? 200 : 503).send({ ok: Boolean(db && redis), db, redis });
  });

  // Metrics used to be served to anyone who could reach the API, trusting the load balancer
  // not to route the path: one misconfigured rule from publishing internal counters. Now the
  // API itself refuses: METRICS_TOKEN (header x-metrics-token) when configured, otherwise a
  // private source address. Not found, not forbidden — the path need not advertise itself.
  const token = app.deps.cfg.METRICS_TOKEN ? Buffer.from(app.deps.cfg.METRICS_TOKEN) : null;
  const allowed = (req: FastifyRequest) => {
    if (token) {
      const got = Buffer.from(String(req.headers['x-metrics-token'] ?? ''));
      return got.length === token.length && timingSafeEqual(got, token);
    }
    return ipInCidrs(req.trustedIp, PRIVATE) || req.trustedIp === '::1';
  };
  app.get('/health/metrics', async (req, reply) => {
    if (!allowed(req)) {
      return reply.type('application/problem+json').code(404).send({
        type: 'https://api.sidequest.co.ke/errors/NOT_FOUND', title: 'Not found', status: 404, code: 'NOT_FOUND',
      });
    }
    return reply.type('text/plain').send(metrics.render());
  });
}
