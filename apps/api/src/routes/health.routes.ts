// apps/api/src/routes/health.routes.ts
// Liveness answers "is the process up"; readiness answers "can it serve", checking the two
// shared dependencies 06-services.md §6.4 names. Metrics are internal-only in deployment
// (the load balancer does not route /health/metrics publicly).

import type { FastifyInstance } from 'fastify';
import { metrics } from '@sidequest/observability';

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

  app.get('/health/metrics', async (_req, reply) => reply.type('text/plain').send(metrics.render()));
}
