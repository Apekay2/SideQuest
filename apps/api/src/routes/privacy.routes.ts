// apps/api/src/routes/privacy.routes.ts
// The data subject's rights under the Kenya Data Protection Act 2019 (s.26), and the store rules
// that require in-app account deletion:
//   GET  /me/export            access: everything held about the caller, as JSON
//   POST /me/delete            erasure: close the account and delete what the law lets us
//   GET|POST /me/location-consent   give or withdraw consent to live location, timestamped
//
// Erasure keeps the ledger, payments, rulings and the other party's errand history, which
// financial-records law requires; it pseudonymises the account those rows point to.

import type { FastifyInstance } from 'fastify';
import { DeleteAccount, LocationConsentBody, type LocationConsent } from '@sidequest/contracts';
import { ledgerBalance, type Tx } from '@sidequest/db';
import { logger } from '@sidequest/observability';
import { AppError } from '../plugins/errors.js';
import { LIMITS } from '../plugins/rate-limit.js';
import { parse } from '../lib/validate.js';

async function owed(tx: Tx, me: string) {
  const wallet = await ledgerBalance(tx, { account: 'user_wallet', ownerId: me });
  const earnings = await ledgerBalance(tx, { account: 'runner_earnings', ownerId: me });
  const [p] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM payment WHERE account_id = ${me} AND status IN ('initiated', 'pending')`;
  const [q] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM payout WHERE runner_id = ${me} AND status IN ('queued', 'sent')`;
  return { wallet_cents: Number(wallet), earnings_cents: Number(earnings), payments_in_flight: p!.n + q!.n };
}

export default async function privacyRoutes(app: FastifyInstance) {
  const { storage } = app.deps;

  app.get('/me/export', { preHandler: [app.requireAuth, app.limit(LIMITS.writes)] }, async (req, reply) => {
    const me = req.actor!.id;
    const data = await app.tx(req, async (tx) => ({
      exported_at: new Date().toISOString(),
      account: (await tx`SELECT id, display_name, app_my_msisdn() AS msisdn, role, verification_tier, language, market, created_at
                           FROM account WHERE id = ${me}`)[0] ?? null,
      legal_acceptances: await tx`SELECT document, version, adult, accepted_at FROM legal_acceptance
                                   WHERE account_id = ${me} ORDER BY accepted_at`,
      // Document images and the encrypted ID number stay in storage; the record says what is held.
      verification: await tx`SELECT target_tier, status, created_at, reviewed_at, reject_reason,
                                    movement_consent, movement_consent_at,
                                    id_number_enc IS NOT NULL AS id_number_held,
                                    (id_front_key IS NOT NULL OR id_back_key IS NOT NULL) AS id_images_held,
                                    selfie_key IS NOT NULL AS selfie_held, conduct_cert_key IS NOT NULL AS conduct_cert_held,
                                    next_of_kin_enc IS NOT NULL AS next_of_kin_held
                               FROM kyc_case WHERE account_id = ${me} ORDER BY created_at`,
      errands: await tx`SELECT id, kind, title, status, created_at,
                               CASE WHEN requester_id = ${me} THEN 'requester' ELSE 'runner' END AS side
                          FROM errand WHERE requester_id = ${me} OR runner_id = ${me} ORDER BY created_at`,
      messages_sent: await tx`SELECT errand_id, body, created_at FROM message WHERE sender_id = ${me} ORDER BY created_at`,
      payments: await tx`SELECT direction, amount_cents, status, created_at FROM payment
                          WHERE account_id = ${me} ORDER BY created_at`,
      ledger: await tx`SELECT p.account, p.amount_cents, g.reason, g.errand_id, p.created_at
                         FROM posting p JOIN posting_group g ON g.id = p.group_id
                        WHERE p.owner_id = ${me} ORDER BY p.id`,
      notifications: await tx`SELECT channel, template, sent_at, read_at, created_at FROM notification
                               WHERE account_id = ${me} ORDER BY created_at`,
    }));
    return reply
      .header('content-disposition', 'attachment; filename="sidequest-my-data.json"')
      .header('cache-control', 'no-store')
      .send(data);
  });

  app.post('/me/delete', { preHandler: [app.requireAuth, app.limit(LIMITS.writes)] }, async (req, reply) => {
    parse(DeleteAccount, req.body);
    if (req.actor!.role === 'staff') throw new AppError(403, 'FORBIDDEN', 'Staff accounts are closed by a staff admin');
    const me = req.actor!.id;
    const keys = await app.tx(req, async (tx) => {
      const o = await owed(tx, me);
      if (o.wallet_cents !== 0 || o.earnings_cents !== 0 || o.payments_in_flight > 0) {
        throw new AppError(409, 'ACCOUNT_HAS_BALANCE', 'Withdraw your balance before closing your account', o);
      }
      try {
        const [r] = await tx<{ keys: string[] }[]>`SELECT app_erase_self() AS keys`;
        return r!.keys;
      } catch (e) {
        const hint = (e as { hint?: string }).hint;
        if (hint === 'LIVE_ERRANDS') throw new AppError(409, 'LIVE_ERRANDS', 'Finish or cancel your errands in progress first');
        if (hint === 'OPEN_DISPUTE') throw new AppError(409, 'OPEN_DISPUTE', 'A dispute on one of your errands is still open');
        throw e;
      }
    });
    // The rows are gone; now the documents. A failure here is logged with the key count only,
    // and the retention pass would not find these keys again, so it is retried in place.
    let failed = 0;
    for (const key of keys) {
      try { await storage.delete(key); }
      catch { try { await storage.delete(key); } catch { failed++; } }
    }
    if (failed) logger.error({ account: me, failed }, 'erasure: stored documents not deleted');
    return reply.code(204).send();
  });

  app.get('/me/location-consent', { preHandler: app.requireAuth }, async (req): Promise<LocationConsent> => {
    const [c] = await app.tx(req, (tx) => tx<{ movement_consent: boolean; movement_consent_at: Date | null }[]>`
      SELECT movement_consent, movement_consent_at FROM kyc_case
       WHERE account_id = ${req.actor!.id} AND target_tier = 3 AND status = 'approved'
       ORDER BY created_at DESC LIMIT 1`);
    return { consent: c ? c.movement_consent : null, changed_at: c?.movement_consent_at?.toISOString() ?? null };
  });

  app.post('/me/location-consent', { preHandler: [app.requireAuth, app.limit(LIMITS.writes)] }, async (req, reply) => {
    const { consent } = parse(LocationConsentBody, req.body);
    const ok = await app.tx(req, async (tx) => (await tx<{ ok: boolean }[]>`SELECT app_set_movement_consent(${consent}) AS ok`)[0]!.ok);
    if (!ok) throw new AppError(409, 'TIER_REQUIRED', 'Location sharing is part of tier-3 verification');
    return reply.code(204).send();
  });
}
