// apps/api/src/plugins/auth.ts
// Bearer JWT → req.actor. Access tokens are 15 minutes (env.ts caps JWT_TTL_SECONDS at 900),
// HS256, carrying sub, role, tier, ent[] and sid (04-api.md). The gateway rejects unentitled
// writes from the claims alone; RLS rejects them again at the database.

import fp from 'fastify-plugin';
import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { entitlementsFor, minimumTierFor, type Entitlement, type Tier } from '@sidequest/domain/kyc/entitlements';
import { withActor } from '@sidequest/db';
import { AppError } from './errors.js';
import type { Actor } from '../types.js';

const ISSUER = 'sidequest-api';

export interface TokenInput {
  accountId: string;
  role: Actor['role'];
  tier: Tier;
  staffGrants: readonly string[];
  sessionId: string;
  legal?: boolean;
}

export async function signAccess(secret: string, ttlSeconds: number, t: TokenInput): Promise<string> {
  const ent = entitlementsFor(t.tier, t.staffGrants as Entitlement[]);
  return new SignJWT({ role: t.role, tier: t.tier, ent, sid: t.sessionId, lg: Boolean(t.legal) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(t.accountId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

/** Opaque refresh token; only its hash is stored. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Verify an access token and return its actor and expiry. Shared by HTTP and the WebSocket. */
export async function verifyAccess(key: Uint8Array, token: string): Promise<{ actor: Actor; exp: number }> {
  const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
  return {
    actor: {
      id: String(payload.sub),
      role: payload.role as Actor['role'],
      tier: Number(payload.tier) as Actor['tier'],
      entitlements: Array.isArray(payload.ent) ? (payload.ent as string[]) : [],
      sessionId: String(payload.sid),
      legal: payload.lg === true,
    },
    exp: Number(payload.exp),
  };
}

/** True while the session behind a token is neither revoked nor expired. */
export async function sessionLive(sql: Parameters<typeof withActor>[0], actor: Actor): Promise<boolean> {
  const [row] = await withActor(sql, actor, (tx) => tx<{ revoked_at: Date | null; expires_at: Date }[]>`
    SELECT revoked_at, expires_at FROM session WHERE id = ${actor.sessionId}`);
  return !!row && !row.revoked_at && row.expires_at > new Date();
}

export default fp(async function auth(app: FastifyInstance) {
  const key = new TextEncoder().encode(app.deps.cfg.JWT_SECRET);

  // Parse the bearer on every request so the rate limiter can count per account. An invalid
  // or expired token is a 401 here rather than an anonymous request further down: silently
  // downgrading a bad token to "anonymous" is how a stale client ends up rate-limited by IP.
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    if (!h) return;
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in again');
    try {
      req.actor = (await verifyAccess(key, m[1]!)).actor;
    } catch {
      throw new AppError(401, 'UNAUTHENTICATED', 'Sign in again');
    }
  });

  // Agreement before action: until the person has accepted the terms and privacy notice in
  // force, nothing that changes data runs. Reading still works, so they can see their errands
  // and money. Exempt: signing in and out, accepting, closing the account, and SOS — a safety
  // call is never held behind paperwork. Staff are not party to the consumer terms.
  const LEGAL_EXEMPT = new Set(['/me/legal', '/me/delete', '/me/push-token', '/me/location-consent', '/errands/:id/sos']);
  app.addHook('preHandler', async (req) => {
    const a = req.actor;
    if (!a || a.legal || a.role === 'staff') return;
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const route = req.routeOptions.url ?? '';
    if (route.startsWith('/auth/') || LEGAL_EXEMPT.has(route)) return;
    throw new AppError(403, 'LEGAL_ACCEPTANCE_REQUIRED', 'Accept the updated terms and privacy notice to continue');
  });

  app.decorate('requireAuth', async (req) => {
    if (!req.actor) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in first');
  });

  app.decorate('requireRole', (role: Actor['role']) => async (req) => {
    if (!req.actor) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in first');
    if (req.actor.role !== role) throw new AppError(403, 'FORBIDDEN', `Switch to your ${role} profile for this`);
  });

  app.decorate('requireEntitlement', (ent: string) => async (req) => {
    if (!req.actor) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in first');
    if (!req.actor.entitlements.includes(ent)) {
      const min = minimumTierFor(ent as Entitlement);
      throw new AppError(403, 'TIER_REQUIRED', `Verification tier ${min} is needed for this`, { needed: ent, minimum_tier: min });
    }
  });

  // Money paths re-check the session row, not just the token: a revoked session must stop
  // moving money now, not at the end of the access token's 15 minutes.
  app.decorate('assertSessionIntegrity', async (req) => {
    const actor = req.actor;
    if (!actor) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in first');
    const s = await withActor(app.deps.sql, actor, (tx) => tx<{
      revoked_at: Date | null; expires_at: Date; device_id: string | null; family_id: string;
    }[]>`SELECT revoked_at, expires_at, device_id, family_id FROM session WHERE id = ${actor.sessionId}`);
    const row = s[0];
    if (!row || row.revoked_at) throw new AppError(401, 'SESSION_REVOKED', 'Sign in again');
    if (row.expires_at <= new Date()) throw new AppError(401, 'SESSION_EXPIRED', 'Sign in again');
    const device = req.headers['x-device-id'];
    if (typeof device === 'string' && row.device_id && device !== row.device_id) {
      // A token presented from a different device than it was issued to: revoke the family.
      req.log.warn({ session: actor.sessionId }, 'device mismatch; revoking session family');
      await withActor(app.deps.sql, actor, (tx) =>
        tx`UPDATE session SET revoked_at = now() WHERE family_id = ${row.family_id} AND revoked_at IS NULL`,
      { sessionFamily: row.family_id });
      throw new AppError(401, 'SESSION_REVOKED', 'Sign in again');
    }
  });
});
