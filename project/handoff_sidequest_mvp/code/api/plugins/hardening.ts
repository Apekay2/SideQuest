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
import { config, isProd } from '@sidequest/config';
import { AppError } from './errors.js';

export default fp(async function hardening(app: FastifyInstance) {
  const cfg = config();
  const origins = cfg.ALLOWED_ORIGINS;

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
    reply.header('Access-Control-Allow-Headers', 'authorization,content-type,idempotency-key');
    reply.header('Access-Control-Max-Age', '600');
    reply.header('Vary', 'Origin');
  });

  // ── Cross-site write protection for the cookie-authenticated console. The mobile app sends
  // a bearer token and no cookie, so it is unaffected.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (!req.headers.cookie) return;
    const origin = req.headers.origin ?? req.headers.referer;
    if (!origin || !origins.some((o) => origin.startsWith(o))) {
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

  // ── Session binding. A token lifted from one device should not work from another. Not
  // absolute (a matatu roams between cell networks, so the IP is advisory only), but the
  // device fingerprint and the session family are checked hard.
  app.decorate('assertSessionIntegrity', async (req: any) => {
    const s = req.session;                       // loaded by the auth plugin from `session`
    if (!s) throw new AppError(401, 'NO_SESSION', 'Sign in again');
    if (s.revokedAt) throw new AppError(401, 'SESSION_REVOKED', 'Sign in again');
    if (s.expiresAt <= new Date()) throw new AppError(401, 'SESSION_EXPIRED', 'Sign in again');

    // Device binding: the refresh token is issued against a device key the app holds in
    // Keystore/Keychain. A mismatch revokes the whole family — this is the control that
    // turns a successful token theft into one failed request.
    if (req.headers['x-device-id'] && s.deviceId && req.headers['x-device-id'] !== s.deviceId) {
      req.log.warn({ session: s.id }, 'device mismatch; revoking session family');
      await app.repos.sessions.revokeFamily(s.familyId, 'device_mismatch');
      throw new AppError(401, 'SESSION_REVOKED', 'Sign in again');
    }

    // Sudden country change on a money path is worth a step-up, not a block.
    if (req.routeOptions?.config?.money && s.lastCountry && req.geoCountry
        && s.lastCountry !== req.geoCountry) {
      throw new AppError(401, 'REAUTH_REQUIRED', 'Confirm it is you');
    }
  });

  // ── Error scrubbing. Two things leak here in practice: a provider message quoted verbatim
  // (which tells a card tester exactly which BIN check failed), and a stack trace naming
  // internal hosts. §7.7 forbids both; this is where it is enforced rather than hoped for.
  app.setErrorHandler((err: any, req, reply) => {
    const isApp = err instanceof AppError;
    const status = isApp ? err.status : (err.statusCode && err.statusCode < 500 ? err.statusCode : 500);
    if (status >= 500) req.log.error({ err }, 'unhandled');

    reply.type('application/problem+json').code(status).send({
      type: `https://api.sidequest.co.ke/errors/${isApp ? err.code : 'INTERNAL'}`,
      title: isApp ? err.message : 'Something went wrong on our side',
      status,
      code: isApp ? err.code : 'INTERNAL',
      // Only AppError details are ever echoed, and only after passing through the same
      // scrubber the logs use, so an msisdn or a lat/lng cannot ride out on an error.
      ...(isApp && err.details ? { details: app.scrub(err.details) } : {}),
      request_id: req.id,
      ...(isProd() ? {} : { debug: String(err?.message ?? '') }),
    });
  });

  // ── Body and header ceilings. Cheap, and they close off the "one 40 MB JSON body per
  // connection" denial of service that no rate limiter counted.
  app.addHook('onRequest', async (req) => {
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > 256 * 1024) throw new AppError(413, 'BODY_TOO_LARGE', 'Request too large');
  });
});
