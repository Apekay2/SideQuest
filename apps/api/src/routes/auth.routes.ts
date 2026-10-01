// apps/api/src/routes/auth.routes.ts
// Phone OTP → short-lived JWT + rotating refresh token (identity service, 06-services.md).
//
// RLS shapes this file. Pre-authentication there is no actor, so every read goes through a
// purpose-scoped GUC that the handler sets only once it has earned it (0006 §4):
//   app.otp_challenge_id   the challenge the caller is answering
//   app.login_msisdn       set only AFTER the code verified, in the same transaction
//   app.refresh_hash       the hash of the refresh token presented
//   app.session_family     for revoking a family on reuse

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { OtpRequest, OtpVerify, RefreshRequest, PatchMe, PushTokenBody, LegalAcceptance, LEGAL_VERSIONS, type Me, type Session } from '@sidequest/contracts';
import { cleanMsisdn, cleanName, InvalidTextError } from '@sidequest/domain/text/sanitize';
import { entitlementsFor, type Entitlement, type Tier } from '@sidequest/domain/kyc/entitlements';
import { withActor, setScope, type Tx } from '@sidequest/db';
import { AppError } from '../plugins/errors.js';
import { LIMITS } from '../plugins/rate-limit.js';
import { parse } from '../lib/validate.js';
import { signAccess, newRefreshToken, hashToken } from '../plugins/auth.js';

const OTP_TTL_MS = 5 * 60_000;
const MAX_OTP_ATTEMPTS = 3;

interface AccountRow {
  id: string; display_name: string; role: Me['role']; verification_tier: number;
  language: 'en' | 'sw'; market: string; staff_grants: string[]; suspended_at: Date | null;
}

/** Whether the account has accepted the terms and privacy notice in force. Staff are not asked. */
export async function legalCurrent(tx: Tx, account: Pick<AccountRow, 'id' | 'role'>): Promise<boolean> {
  if (account.role === 'staff') return true;
  const [r] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM legal_acceptance
     WHERE account_id = ${account.id}
       AND ((document = 'terms' AND version = ${LEGAL_VERSIONS.terms})
         OR (document = 'privacy' AND version = ${LEGAL_VERSIONS.privacy}))`;
  return r!.n === 2;
}

/** Record acceptance of the current documents (idempotent). The actor must be in scope. */
async function recordAcceptance(tx: Tx, accountId: string) {
  for (const [document, version] of Object.entries(LEGAL_VERSIONS)) {
    await tx`INSERT INTO legal_acceptance (account_id, document, version, adult)
             VALUES (${accountId}, ${document}, ${version}, true) ON CONFLICT DO NOTHING`;
  }
}

export function toMe(a: AccountRow, legal: boolean): Me {
  return {
    id: a.id,
    display_name: a.display_name,
    role: a.role,
    verification_tier: a.verification_tier as Me['verification_tier'],
    entitlements: entitlementsFor(a.verification_tier as Tier, a.staff_grants as Entitlement[]),
    language: a.language,
    market: a.market,
    legal_current: legal,
  };
}

export default async function authRoutes(app: FastifyInstance) {
  const { cfg, sql, sms } = app.deps;

  /** Hash with a server key so a database dump is not a phone book (also the limiter key). */
  const msisdnKey = (msisdn: string) => createHmac('sha256', cfg.COOKIE_SECRET).update(msisdn).digest('hex').slice(0, 32);
  const codeHash = (challengeId: string, code: string) =>
    createHmac('sha256', cfg.COOKIE_SECRET).update(`${challengeId}:${code}`).digest('hex');

  function msisdnOrThrow(raw: unknown): string {
    try { return cleanMsisdn(raw); } catch (e) {
      if (e instanceof InvalidTextError) throw new AppError(400, 'VALIDATION', e.message);
      throw e;
    }
  }

  // ─────────────────────────────────────────── POST /auth/otp

  app.post('/auth/otp', {
    preHandler: [
      async (req) => {
        // Canonicalise BEFORE the limiter so 0722…, +254722… and 254722… share one bucket.
        const { msisdn } = parse(OtpRequest, req.body);
        req.hashedMsisdn = msisdnKey(msisdnOrThrow(msisdn));
      },
      app.limit(LIMITS.otpRequest, LIMITS.otpRequestIp),
    ],
  }, async (req, reply) => {
    const msisdn = msisdnOrThrow(parse(OtpRequest, req.body).msisdn);
    const id = randomUUID();
    // The app-store review number (config): a fixed code, no SMS. Logged every time.
    const review = Boolean(cfg.REVIEW_LOGIN_MSISDN && cfg.REVIEW_LOGIN_CODE && msisdn === cfg.REVIEW_LOGIN_MSISDN);
    const code = review ? cfg.REVIEW_LOGIN_CODE! : String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await withActor(sql, null, (tx) => tx`
      INSERT INTO otp_challenge (id, msisdn, code_hash, expires_at)
      VALUES (${id}, ${msisdn}, ${codeHash(id, code)}, ${expiresAt})`, { otpChallengeId: id });

    // The one third-party call in a request path: an OTP that waits behind a queue is an OTP
    // the user has given up on. Everything else goes through the outbox.
    try {
      if (review) req.log.warn({ challenge: id }, 'app-review sign-in requested (fixed code, no SMS)');
      else await sms.send(msisdn, `Your Side Qwest code is ${code}. It expires in 5 minutes. Never share it.`);
    } catch (err) {
      req.log.error({ err }, 'otp sms failed');
      throw new AppError(503, 'SMS_UNAVAILABLE', 'We could not send the code. Try again shortly.');
    }

    // Same response whether or not the number has an account: this endpoint must not be a
    // registration oracle.
    return reply.code(201).send({ challenge_id: id, expires_at: expiresAt.toISOString() });
  });

  // ─────────────────────────────────────────── POST /auth/verify

  app.post('/auth/verify', async (req, reply) => {
    const body = parse(OtpVerify, req.body);
    // Present → must be the current versions with the 18+ confirmation; absent is allowed only
    // for an existing account (checked below).
    const accept = body.accept_legal === undefined ? null : LegalAcceptance.safeParse(body.accept_legal);
    if (accept && !accept.success) {
      throw new AppError(400, 'LEGAL_ACCEPTANCE_REQUIRED', 'Accept the current terms and privacy notice, and confirm you are 18 or older');
    }

    const challenge = await withActor(sql, null, async (tx) => {
      const [c] = await tx<{ msisdn: string; code_hash: string; attempts: number; expires_at: Date; consumed_at: Date | null }[]>`
        SELECT msisdn, code_hash, attempts, expires_at, consumed_at FROM otp_challenge WHERE id = ${body.challenge_id}`;
      return c;
    }, { otpChallengeId: body.challenge_id });

    if (!challenge) throw new AppError(400, 'OTP_INVALID', 'That code is not valid');
    req.hashedMsisdn = msisdnKey(challenge.msisdn);
    await app.limit(LIMITS.otpVerify).call(app, req, reply);

    if (challenge.consumed_at || challenge.expires_at < new Date() || challenge.attempts >= MAX_OTP_ATTEMPTS) {
      throw new AppError(400, 'OTP_INVALID', 'That code has expired. Request a new one.');
    }

    const want = Buffer.from(challenge.code_hash);
    const got = Buffer.from(codeHash(body.challenge_id, body.code));
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      // Count the failure in its own committed transaction: the throw below must not roll
      // the counter back, or the attempt limit is decorative.
      await withActor(sql, null, (tx) => tx`
        UPDATE otp_challenge SET attempts = attempts + 1 WHERE id = ${body.challenge_id}`,
      { otpChallengeId: body.challenge_id });
      throw new AppError(400, 'OTP_INVALID', 'That code is not valid');
    }

    const session = await withActor(sql, null, async (tx) => {
      const consumed = await tx`
        UPDATE otp_challenge SET consumed_at = now()
         WHERE id = ${body.challenge_id} AND consumed_at IS NULL
        RETURNING id`;
      // Two verifies racing with the right code: exactly one proceeds.
      if (consumed.length === 0) throw new AppError(400, 'OTP_INVALID', 'That code has already been used');

      // Earned: this transaction may now see (only) the account for this number.
      await setScope(tx, 'app.login_msisdn', challenge.msisdn);
      let [account] = await tx<AccountRow[]>`
        SELECT id, display_name, role, verification_tier, language, market, staff_grants, suspended_at FROM account`;

      // One answer for "no account" and "not staff", so the console cannot be used to learn
      // which numbers are registered.
      // The review number is for the customer apps only, never the console, even if someone
      // made it staff.
      if (body.staff_only && (account?.role !== 'staff' || challenge.msisdn === cfg.REVIEW_LOGIN_MSISDN)) {
        throw new AppError(403, 'NOT_STAFF', 'This number has no console access');
      }
      if (!account) {
        // No contract without agreement: an account is created only with the current terms
        // and privacy notice accepted, by someone who confirms they are an adult.
        if (!accept) {
          throw new AppError(400, 'LEGAL_ACCEPTANCE_REQUIRED', 'Accept the current terms and privacy notice, and confirm you are 18 or older');
        }
        let displayName = 'Mwanachama';
        if (body.display_name) {
          try { displayName = cleanName('display_name', body.display_name); } catch (e) {
            throw new AppError(400, 'VALIDATION', (e as Error).message);
          }
        }
        [account] = await tx<AccountRow[]>`
          INSERT INTO account (msisdn, display_name, role, verification_tier, language, market)
          VALUES (${challenge.msisdn}, ${displayName}, ${body.role ?? 'requester'}, 1, 'en', 'KE')
          RETURNING id, display_name, role, verification_tier, language, market, staff_grants, suspended_at`;
      }
      if (account!.suspended_at) throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Contact support.');

      if (accept && account!.role !== 'staff') {
        await setScope(tx, 'app.actor_id', account!.id);
        await recordAcceptance(tx, account!.id);
      }
      return issueSession(tx, account!, body.device_id ?? null, null);
    }, { otpChallengeId: body.challenge_id });

    app.setRefreshCookie(reply, session.refresh);
    return reply.send(session);
  });

  async function issueSession(tx: Tx, account: AccountRow, deviceId: string | null, familyId: string | null): Promise<Session> {
    await setScope(tx, 'app.actor_id', account.id);
    const { token, hash } = newRefreshToken();
    const expires = new Date(Date.now() + cfg.REFRESH_TTL_DAYS * 86_400_000);
    const [s] = await tx<{ id: string }[]>`
      INSERT INTO session (account_id, refresh_hash, device_label, device_id, expires_at, family_id)
      VALUES (${account.id}, ${hash}, ${null}, ${deviceId}, ${expires},
              ${familyId ?? randomUUID()})
      RETURNING id`;
    const legal = await legalCurrent(tx, account);
    const access = await signAccess(cfg.JWT_SECRET, cfg.JWT_TTL_SECONDS, {
      accountId: account.id,
      role: account.role,
      tier: account.verification_tier as Tier,
      staffGrants: account.role === 'staff' ? account.staff_grants : [],
      sessionId: s!.id,
      legal,
    });
    return { access, refresh: token, expires_in: cfg.JWT_TTL_SECONDS, account: toMe(account, legal) };
  }

  // ─────────────────────────────────────────── POST /auth/refresh

  app.post('/auth/refresh', {
    preHandler: app.limit({ name: 'auth.refresh', max: 30, windowSeconds: 3600, by: 'ip', onRedisDown: 'allow' }),
  }, async (req, reply) => {
    const { refresh: fromBody } = parse(RefreshRequest, req.body);
    const cookie = req.cookies.sq_refresh ? req.unsignCookie(req.cookies.sq_refresh) : null;
    const token = fromBody ?? (cookie?.valid ? cookie.value : null);
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in again');
    const hash = hashToken(token);

    const outcome = await withActor(sql, null, async (tx) => {
      const [s] = await tx<{ id: string; account_id: string; family_id: string; revoked_at: Date | null;
                             rotated_at: Date | null; expires_at: Date; device_id: string | null }[]>`
        SELECT id, account_id, family_id, revoked_at, rotated_at, expires_at, device_id
          FROM session WHERE refresh_hash = ${hash}`;
      if (!s || s.revoked_at || s.expires_at < new Date()) return { kind: 'invalid' as const };
      if (s.rotated_at) {
        // A spent refresh token presented again: one of the two holders is not the user.
        // Revoke the whole family (04-api.md) — the legitimate device signs in again.
        await setScope(tx, 'app.actor_id', s.account_id);
        await tx`SELECT set_config('app.session_family', ${s.family_id}, true)`;
        await tx`UPDATE session SET revoked_at = now() WHERE family_id = ${s.family_id} AND revoked_at IS NULL`;
        return { kind: 'reuse' as const, familyId: s.family_id };
      }
      await setScope(tx, 'app.actor_id', s.account_id);
      await tx`UPDATE session SET rotated_at = now() WHERE id = ${s.id}`;
      const [account] = await tx<AccountRow[]>`
        SELECT id, display_name, role, verification_tier, language, market, staff_grants, suspended_at
          FROM account WHERE id = ${s.account_id}`;
      if (!account || account.suspended_at) return { kind: 'invalid' as const };
      return { kind: 'ok' as const, session: await issueSession(tx, account, s.device_id, s.family_id) };
    }, { refreshHash: hash });

    if (outcome.kind === 'reuse') {
      req.log.warn({ family: outcome.familyId }, 'refresh token reuse; family revoked');
      app.clearRefreshCookie(reply);
      throw new AppError(401, 'SESSION_REVOKED', 'Sign in again');
    }
    if (outcome.kind === 'invalid') {
      app.clearRefreshCookie(reply);
      throw new AppError(401, 'UNAUTHENTICATED', 'Sign in again');
    }
    app.setRefreshCookie(reply, outcome.session.refresh);
    return reply.send(outcome.session);
  });

  // ─────────────────────────────────────────── POST /auth/logout

  app.post('/auth/logout', { preHandler: app.requireAuth }, async (req, reply) => {
    await app.tx(req, (tx) => tx`UPDATE session SET revoked_at = now() WHERE id = ${req.actor!.sessionId}`);
    app.clearRefreshCookie(reply);
    return reply.code(204).send();
  });

  // ─────────────────────────────────────────── /me

  async function loadMe(req: FastifyRequest, tx: Tx): Promise<AccountRow> {
    const [a] = await tx<AccountRow[]>`
      SELECT id, display_name, role, verification_tier, language, market, staff_grants, suspended_at
        FROM account WHERE id = ${req.actor!.id}`;
    if (!a) throw new AppError(404, 'NOT_FOUND', 'Account not found');
    return a;
  }

  // ─────────────────────────────────────────── push tokens

  /** Register this device for push. A token held by another account moves to this one. */
  app.post('/me/push-token', { preHandler: [app.requireAuth, app.limit(LIMITS.writes)] }, async (req, reply) => {
    const { token, platform } = parse(PushTokenBody, req.body);
    await app.tx(req, (tx) => tx`SELECT app_claim_push_token(${token}, ${platform})`);
    return reply.code(204).send();
  });

  /** Signing out: this device stops receiving this account's notifications. */
  app.delete('/me/push-token', { preHandler: [app.requireAuth, app.limit(LIMITS.writes)] }, async (req, reply) => {
    const { token } = parse(PushTokenBody.pick({ token: true }), req.body);
    await app.tx(req, (tx) => tx`DELETE FROM push_token WHERE token = ${token}`);
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: app.requireAuth }, async (req) => app.tx(req, async (tx) => {
    const a = await loadMe(req, tx);
    return toMe(a, await legalCurrent(tx, a));
  }));

  /**
   * Accept the terms and privacy notice in force (after they change). The client then refreshes
   * its session, whose new access token carries the acceptance.
   */
  app.post('/me/legal', { preHandler: [app.requireAuth, app.limit(LIMITS.writes)] }, async (req, reply) => {
    parse(LegalAcceptance, req.body);
    if (req.actor!.role === 'staff') return reply.code(204).send();
    await app.tx(req, (tx) => recordAcceptance(tx, req.actor!.id));
    return reply.code(204).send();
  });

  app.patch('/me', { preHandler: app.requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parse(PatchMe, req.body);
    let name: string | undefined;
    if (body.display_name !== undefined) {
      try { name = cleanName('display_name', body.display_name); } catch (e) {
        throw new AppError(400, 'VALIDATION', (e as Error).message);
      }
    }
    if (body.role && req.actor!.role === 'staff') throw new AppError(403, 'FORBIDDEN', 'Staff accounts cannot switch role');
    const me = await app.tx(req, async (tx) => {
      await tx`
        UPDATE account SET
          display_name = COALESCE(${name ?? null}, display_name),
          language     = COALESCE(${body.language ?? null}, language),
          role         = COALESCE(${body.role ?? null}::actor_role, role),
          updated_at   = now()
         WHERE id = ${req.actor!.id}`;
      const a = await loadMe(req, tx);
      return { a, legal: await legalCurrent(tx, a) };
    });
    // A role switch changes the token's claims; the client refreshes to pick them up.
    return reply.send({ ...toMe(me.a, me.legal), refresh_required: Boolean(body.role && body.role !== req.actor!.role) });
  });
}
