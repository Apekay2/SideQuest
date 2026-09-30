// apps/api/src/plugins/rate-limit.ts
// §7.7's rate limits, as code. They were documented and unimplemented: /auth/otp had no
// counter (so "5 OTP per hour" was aspirational), and /runners/nearby had none (so the map
// was scrapeable at request speed by any tier-1 account).
//
// Sliding window in Redis, counted with one round trip per check. The window is a sorted set
// rather than a fixed-bucket INCR because a fixed bucket lets an attacker fire 2x the limit
// across a boundary — which for OTP means 10 SMS to one number in two seconds.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

export interface Limit {
  /** Bucket name; appears in metrics and in the 429 body. */
  name: string;
  max: number;
  windowSeconds: number;
  /** What we count per. Keep it as narrow as the abuse it prevents. */
  by: 'account' | 'ip' | 'msisdn' | 'errand' | 'account+errand';
  /** Fail closed (money, OTP, KYC) or fail open (read paths) when Redis is unavailable. */
  onRedisDown: 'deny' | 'allow';
}

// The registry IS the policy. §7.7 of the security doc quotes this table; if you change a
// number here, change it there in the same commit.
export const LIMITS = {
  otpRequest:      { name: 'otp.request',      max: 5,   windowSeconds: 3600, by: 'msisdn',         onRedisDown: 'deny'  },
  otpRequestIp:    { name: 'otp.request.ip',   max: 20,  windowSeconds: 3600, by: 'ip',             onRedisDown: 'deny'  },
  otpVerify:       { name: 'otp.verify',       max: 3,   windowSeconds: 900,  by: 'msisdn',         onRedisDown: 'deny'  },
  writes:          { name: 'write',            max: 60,  windowSeconds: 60,   by: 'account',        onRedisDown: 'allow' },
  reads:           { name: 'read',             max: 300, windowSeconds: 60,   by: 'account',        onRedisDown: 'allow' },
  nearby:          { name: 'runners.nearby',   max: 30,  windowSeconds: 3600, by: 'account',        onRedisDown: 'deny'  },
  locationIngest:  { name: 'location.ingest',  max: 30,  windowSeconds: 60,   by: 'account',        onRedisDown: 'allow' },
  offer:           { name: 'errand.offer',     max: 20,  windowSeconds: 3600, by: 'account',        onRedisDown: 'deny'  },
  accept:          { name: 'errand.accept',    max: 60,  windowSeconds: 60,   by: 'account',        onRedisDown: 'deny'  },
  approval:        { name: 'stall.approve',    max: 12,  windowSeconds: 3600, by: 'account+errand', onRedisDown: 'deny'  },
  payout:          { name: 'payout.create',    max: 5,   windowSeconds: 86400, by: 'account',       onRedisDown: 'deny'  },
  topup:           { name: 'wallet.topup',     max: 10,  windowSeconds: 3600, by: 'account',        onRedisDown: 'deny'  },
  kycSubmit:       { name: 'kyc.submit',       max: 5,   windowSeconds: 86400, by: 'account',       onRedisDown: 'deny'  },
  presign:         { name: 'kyc.presign',      max: 20,  windowSeconds: 3600, by: 'account',        onRedisDown: 'deny'  },
  disputeCreate:   { name: 'dispute.create',   max: 10,  windowSeconds: 86400, by: 'account',       onRedisDown: 'deny'  },
  sos:             { name: 'sos',              max: 10,  windowSeconds: 3600, by: 'account',        onRedisDown: 'allow' }, // never block a real one
} as const satisfies Record<string, Limit>;

// Sliding-window count-and-admit. Atomic, so two concurrent requests cannot both take the
// last slot. Returns remaining slots and the retry-after when denied.
const SCRIPT = `
local key, now, window, max, member = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window * 1000)
local used = redis.call('ZCARD', key)
if used >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window - math.floor((now - tonumber(oldest[2])) / 1000)
  return {0, 0, retry < 1 and 1 or retry}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window * 1000)
return {1, max - used - 1, 0}
`;

function bucketKey(limit: Limit, req: FastifyRequest): string {
  const actor = (req.actor?.id ?? 'anon');
  switch (limit.by) {
    case 'account': return `rl:${limit.name}:${actor}`;
    // Trust the left-most XFF entry only behind our own ALB, and only because the ALB
    // rewrites it. Anywhere else this is spoofable and the limit is worthless.
    case 'ip': return `rl:${limit.name}:${req.trustedIp}`;
    // Hash the msisdn: a Redis dump should not be a phone book. Same reason logs scrub it.
    case 'msisdn': return `rl:${limit.name}:${req.hashedMsisdn ?? 'none'}`;
    case 'errand': return `rl:${limit.name}:${(req.params as any)?.id ?? 'none'}`;
    case 'account+errand': return `rl:${limit.name}:${actor}:${(req.params as any)?.id ?? 'none'}`;
  }
}

export default fp(async function rateLimit(app: FastifyInstance) {
  const sha = await app.redis.scriptLoad(SCRIPT);

  async function check(limit: Limit, req: FastifyRequest, reply: FastifyReply) {
    let admitted: boolean, remaining = 0, retryAfter = 0;
    try {
      const [ok, rem, retry] = await app.redis.evalSha(sha, {
        keys: [bucketKey(limit, req)],
        arguments: [String(Date.now()), String(limit.windowSeconds), String(limit.max), req.id],
      }) as [number, number, number];
      admitted = ok === 1; remaining = rem; retryAfter = retry;
    } catch (err) {
      req.log.error({ err, limit: limit.name }, 'rate limiter unavailable');
      app.metrics.increment('ratelimit.unavailable', { limit: limit.name });
      // A money or OTP path with no limiter is worse than an outage: deny.
      if (limit.onRedisDown === 'deny') {
        throw new AppError(503, 'RATE_LIMITER_UNAVAILABLE', 'Try again shortly');
      }
      return;
    }

    reply.header('RateLimit-Limit', limit.max);
    reply.header('RateLimit-Remaining', Math.max(0, remaining));

    if (!admitted) {
      reply.header('Retry-After', retryAfter);
      app.metrics.increment('ratelimit.denied', { limit: limit.name });
      // No detail about *which* identifier tripped: on the OTP path that would confirm
      // whether a number is registered.
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests', { retry_after_seconds: retryAfter });
    }
  }

  /** Route-level: `preHandler: app.limit(LIMITS.nearby)`. Stacks with the global limits. */
  app.decorate('limit', (...limits: Limit[]) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      for (const l of limits) await check(l, req, reply);
    });

  // Global floor. Every authenticated request is counted even if its route forgot to opt in —
  // the documented 60 writes/min and 300 reads/min per account.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.actor) return;                       // pre-auth paths carry their own limits
    if (req.url.startsWith('/health')) return;
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    await check(write ? LIMITS.writes : LIMITS.reads, req, reply);
  });

  // Unauthenticated surface, counted by IP, so an unauthenticated flood cannot reach the
  // database at all. Deliberately generous — a shared NAT in a Nairobi office is one IP.
  app.addHook('onRequest', async (req, reply) => {
    if (req.actor) return;
    await check({ name: 'anon', max: 120, windowSeconds: 60, by: 'ip', onRedisDown: 'deny' }, req, reply);
  });
});
