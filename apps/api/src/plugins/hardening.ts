// apps/api/src/plugins/hardening.ts
// Transport, header, cookie and session hardening. The threat this file exists for is the
// full chain: a stored string somewhere in an errand renders as script in the ops console,
// the script reads the operator's session, and the attacker inherits `legal_ops`. Breaking
// any single link is not enough, so this closes several:
//
//   1. The token is not reachable from JavaScript      (httpOnly cookie / native secure store)
//   2. A stolen token is not usable elsewhere          (session binding + short TTL)
//   3. Injected script cannot execute                  (CSP, no unsafe-inline, nonce per response)
//   4. Injected script cannot exfiltrate               (connect-src allowlist, no wildcard CORS)
//   5. Cross-site requests cannot ride the cookie      (SameSite + origin check on writes)

import fp from 'fastify-plugin';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { scrub } from '@sidequest/observability';
import { AppError } from './errors.js';

/** The origin of an Origin or Referer header value, or null if it is not a URL. */
export function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try { return new URL(value).origin; } catch { return null; }
}

export default fp(async function hardening(app: FastifyInstance) {
  const cfg = app.deps.cfg;
  const origins = cfg.ALLOWED_ORIGINS;
  const isProd = () => cfg.NODE_ENV === 'production';

  // ── Client IP. Behind our own load balancer the right-most TRUSTED_PROXY_HOPS entries of
  // X-Forwarded-For were appended by infrastructure we control; the entry just before them is
  // the client. Anything further left is client-supplied and spoofable, so it is ignored.
  app.addHook('onRequest', async (req) => {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const hops = cfg.TRUSTED_PROXY_HOPS;
    req.trustedIp = hops > 0 && xff.length >= hops ? xff[xff.length - hops]! : req.socket?.remoteAddress ?? req.ip ?? 'unknown';
  });

  // ── CORS. An allowlist, echoed back only on an exact match. `origin: true` (reflect
  // anything) with credentials is the single most common way a marketplace API hands an
  // attacker's page a session.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin) return;                                   // native app, no Origin header
    if (!origins.includes(origin)) {
      throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Origin not allowed');
    }
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Access-Control-Allow-Headers', 'authorization,content-type,idempotency-key,x-device-id');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Max-Age', '600');
    reply.header('Vary', 'Origin');
  });

  // ── Cross-site write protection for the cookie-authenticated console. The mobile app sends
  // a bearer token and no cookie, so it is unaffected.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (!req.headers.cookie) return;
    // Compare whole origins. A prefix test let https://console.example.com.evil.net pass for
    // https://console.example.com; a Referer is reduced to its origin before comparing.
    const origin = originOf(req.headers.origin ?? req.headers.referer);
    if (!origin || !origins.includes(origin)) {
      throw new AppError(403, 'CSRF_ORIGIN', 'Cross-site write refused');
    }
  });

  // ── Response headers. The API itself returns JSON, but a browser that is tricked into
  // rendering a response inline must not execute anything, and the console inherits the CSP
  // from its own document — both are set from one place so they cannot drift.
  app.addHook('onRequest', async (req, reply) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    (req as any).cspNonce = nonce;
    reply.headers({
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'self' 'nonce-${nonce}'`,   // no unsafe-inline, no unsafe-eval, no CDN
        "style-src 'self'",
        "img-src 'self' data: blob: https://evidence.sidequest.co.ke", // evidence on its own origin
        "font-src 'self'",
        `connect-src 'self' ${cfg.API_PUBLIC_ORIGIN}`,
        "frame-ancestors 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        'upgrade-insecure-requests',
        `report-uri ${cfg.CSP_REPORT_URI ?? '/csp-report'}`,
      ].join('; '),
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      // A location- and camera-using app should still deny what it does not use, and the API
      // origin uses none of it.
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
      'Cache-Control': 'no-store',   // no session-bearing response in a shared cache
    });
    reply.removeHeader('X-Powered-By');
  });

  // ── Cookies. One policy, applied by one helper, so no route can set a weaker one.
  app.setNotFoundHandler((_req, reply) => {
    reply.type('application/problem+json').code(404).send({
      type: 'https://api.sidequest.co.ke/errors/NOT_FOUND', title: 'Not found', status: 404, code: 'NOT_FOUND',
    });
  });

  app.decorate('setRefreshCookie', (reply: any, token: string) => {
    reply.setCookie('sq_refresh', token, {
      httpOnly: true,                 // XSS cannot read it
      secure: true,                   // TLS only, in every environment including staging
      sameSite: 'strict',             // the console is same-site; nothing legitimate is cross-site
      path: '/auth',                  // sent only to the refresh and logout endpoints
      domain: cfg.COOKIE_DOMAIN,
      maxAge: cfg.REFRESH_TTL_DAYS * 86400,
      signed: true,
    });
  });
  app.decorate('clearRefreshCookie', (reply: any) => {
    reply.clearCookie('sq_refresh', { path: '/auth', domain: cfg.COOKIE_DOMAIN });
  });

  // Session binding (device id, revocation, family) lives in auth.ts as
  // assertSessionIntegrity, next to the code that issues the session.

  // ── Preflight. Fastify has no route for OPTIONS; the CORS hook above has already checked
  // the origin and set the headers by the time this answers.
  app.options('/*', async (_req, reply) => reply.code(204).send());

  // ── Error scrubbing. Two things leak here in practice: a provider message quoted verbatim
  // (which tells a card tester exactly which BIN check failed), and a stack trace naming
  // internal hosts. §7.7 forbids both; this is where it is enforced rather than hoped for.
  // Domain errors carry a stable `code`; they are client errors, not faults, and are mapped
  // here once rather than caught in every handler.
  const DOMAIN_STATUS: Record<string, number> = {
    ERRAND_STATE_INVALID: 409, SPEND_CAP_EXCEEDED: 409, TIER_REQUIRED: 403, INVALID_TEXT: 400,
    LEDGER_UNBALANCED: 409, LEDGER_NEGATIVE_AMOUNT: 400, MPESA_WHOLE_SHILLINGS: 400,
  };

  app.setErrorHandler((rawErr: any, req, reply) => {
    const err = rawErr?.code && DOMAIN_STATUS[rawErr.code] && !(rawErr instanceof AppError)
      ? new AppError(DOMAIN_STATUS[rawErr.code]!, rawErr.code, rawErr.message)
      : rawErr;
    const isApp = err instanceof AppError;
    const status = isApp ? err.status : (err.statusCode && err.statusCode < 500 ? err.statusCode : 500);
    // Framework 4xx (malformed JSON, body too large) get a stable code instead of INTERNAL.
    const code = isApp ? err.code : status === 400 ? 'VALIDATION' : status === 413 ? 'BODY_TOO_LARGE'
      : status === 404 ? 'NOT_FOUND' : status < 500 ? 'BAD_REQUEST' : 'INTERNAL';
    if (status >= 500) req.log.error({ err }, 'unhandled');

    reply.type('application/problem+json').code(status).send({
      type: `https://api.sidequest.co.ke/errors/${code}`,
      title: isApp ? err.message : status < 500 ? 'The request could not be processed' : 'Something went wrong on our side',
      status,
      code,
      // Only AppError details are ever echoed, and only after passing through the same
      // scrubber the logs use, so an msisdn or a lat/lng cannot ride out on an error.
      ...(isApp && err.details ? { details: scrub(err.details) } : {}),
      request_id: req.id,
      ...(isProd() || isApp ? {} : { debug: String(err?.message ?? '') }),
    });
  });

  // ── Body and header ceilings. Cheap, and they close off the "one 40 MB JSON body per
  // connection" denial of service that no rate limiter counted. A signed upload PUT carries a
  // photo or a PDF and has its own, larger, route-level limit (uploads.routes.ts).
  app.addHook('onRequest', async (req) => {
    if (req.method === 'PUT' && req.url.startsWith('/uploads/')) return;
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > 256 * 1024) throw new AppError(413, 'BODY_TOO_LARGE', 'Request too large');
  });
});
