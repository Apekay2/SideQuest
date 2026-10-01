// apps/api/src/server.ts
// build() assembles the API from its dependencies. index.ts supplies real ones; tests supply
// the same real ones pointed at a test database, so nothing here is mocked.
//
// Plugin order matters and is deliberate:
//   hardening   client IP, CORS, headers, error scrubbing — before anything can throw
//   auth        parses the bearer so the rate limiter can count per account
//   rate-limit  global per-account and per-IP floors
//   actor/idem  transaction binding and Idempotency-Key replay
//   routes      one plugin per service boundary in 06-services.md

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createDb } from '@sidequest/db';
import type { Config } from '@sidequest/config';
import { LocalStorage, R2Storage, ConsoleSms, AfricasTalkingSms } from '@sidequest/adapters';
import { logger, redactUrl } from '@sidequest/observability';
import type { Deps } from './types.js';

import hardening from './plugins/hardening.js';
import auth from './plugins/auth.js';
import rateLimit from './plugins/rate-limit.js';
import actorContext from './plugins/actor-context.js';
import idempotency from './plugins/idempotency.js';

import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import kycRoutes from './routes/kyc.routes.js';
import errandRoutes from './routes/errands.routes.js';
import assignmentRoutes from './routes/assignment.routes.js';
import stallRoutes from './routes/stalls.routes.js';
import handoverRoutes from './routes/handover.routes.js';
import locationRoutes from './routes/location.routes.js';
import walletRoutes from './routes/wallet.routes.js';
import safetyRoutes from './routes/safety.routes.js';
import opsRoutes from './routes/ops.routes.js';
import opsAdminRoutes from './routes/ops-admin.routes.js';
import webhookRoutes from './routes/webhooks.routes.js';
import uploadRoutes from './routes/uploads.routes.js';
import realtime from './realtime/ws.js';

import './types.js';

export function buildDeps(cfg: Config): Deps {
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false });
  const redisSub = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const localStorage = cfg.STORAGE_DRIVER === 'local'
    ? new LocalStorage(cfg.STORAGE_LOCAL_DIR, cfg.API_PUBLIC_ORIGIN, cfg.COOKIE_SECRET)
    : null;
  return {
    cfg,
    sql: createDb(cfg.DATABASE_URL, { max: cfg.DATABASE_POOL_MAX, application: 'sidequest-api' }),
    opsSql: createDb(cfg.OPS_DATABASE_URL, { max: 4, application: 'sidequest-api-ops' }),
    redis,
    redisSub,
    storage: localStorage ?? new R2Storage({
      accountId: cfg.R2_ACCOUNT_ID!, accessKeyId: cfg.R2_ACCESS_KEY_ID!,
      secretAccessKey: cfg.R2_SECRET_ACCESS_KEY!, bucket: cfg.R2_BUCKET!,
    }),
    localStorage,
    sms: cfg.SMS_DRIVER === 'console'
      ? new ConsoleSms()
      : new AfricasTalkingSms({ username: cfg.AT_USERNAME!, apiKey: cfg.AT_API_KEY!, senderId: cfg.AT_SENDER_ID, sandbox: cfg.NODE_ENV !== 'production' }),
  };
}

export async function build(deps: Deps): Promise<FastifyInstance> {
  // The API's Redis client does not queue commands while disconnected (the rate limiter must
  // fail closed on money paths, not wait). So it has to be connected before the first request.
  if (deps.redis.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Redis did not become ready within 10s')), 10_000);
      deps.redis.once('ready', () => { clearTimeout(t); resolve(); });
    });
  }

  const app = Fastify({
    loggerInstance: logger.child({ component: 'api' }, {
      serializers: {
        req: (r: { method?: string; url?: string; host?: string; ip?: string; socket?: { remoteAddress?: string } }) => ({
          method: r.method, url: redactUrl(r.url), host: r.host, remoteAddress: r.ip ?? r.socket?.remoteAddress,
        }),
      },
    }),
    genReqId: () => randomUUID(),
    bodyLimit: 256 * 1024,
    trustProxy: false,          // hardening.ts resolves the client IP from a fixed hop count
  });
  app.decorate('deps', deps);

  await app.register(cookie, { secret: deps.cfg.COOKIE_SECRET });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  await app.register(hardening);
  await app.register(auth);
  await app.register(rateLimit);
  await app.register(actorContext);
  await app.register(idempotency);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(kycRoutes);
  await app.register(errandRoutes);
  await app.register(assignmentRoutes);
  await app.register(stallRoutes);
  await app.register(handoverRoutes);
  await app.register(locationRoutes);
  await app.register(walletRoutes);
  await app.register(safetyRoutes);
  await app.register(opsRoutes);
  await app.register(opsAdminRoutes);
  await app.register(webhookRoutes);
  await app.register(uploadRoutes);
  await app.register(realtime);

  app.addHook('onClose', async () => {
    await Promise.allSettled([deps.sql.end({ timeout: 5 }), deps.opsSql.end({ timeout: 5 })]);
    deps.redis.disconnect();
    deps.redisSub.disconnect();
  });

  return app as unknown as FastifyInstance;
}
