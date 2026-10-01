// apps/api/src/routes/ops-admin.routes.ts
// Running the business from the console: the overview, people (search, profile, suspension,
// staff access), the SOS queue, the errands list and the finance view. Same pool, gate and
// audit discipline as ops.routes.ts; every write is audited in its own transaction, and the
// database re-checks each entitlement (0008_admin.sql), so a gateway bug cannot widen access.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { StaffGrants, Suspension, SosResolve } from '@sidequest/contracts';
import { cleanMsisdn } from '@sidequest/domain/text/sanitize';
import { enqueueOutbox } from '@sidequest/db';
import { AppError, notFound } from '../plugins/errors.js';
import { parse, ids } from '../lib/validate.js';
import { opsGate, opsAudit, holds, maskMsisdn } from '../lib/ops.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = ['offered', 'awarded', 'en_route', 'shopping', 'awaiting_approval', 'handover'];
const TERMINAL = ['settled', 'cancelled', 'expired'];
/** Ledger accounts where the platform's own income lands. */
const REVENUE = ['platform_fee', 'service_fee_requester', 'maintenance_fee_runner'];

/** A LIKE pattern that matches the text literally. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export default async function opsAdminRoutes(app: FastifyInstance) {
  const gate = opsGate(app);
  const refuse = (e: unknown): never => {
    // The database's per-column guard (0008) speaks in SQLSTATE; turn it into a 403/400.
    const pg = e as { code?: string; message?: string };
    if (pg?.code === '42501') throw new AppError(403, 'FORBIDDEN', pg.message ?? 'Not allowed');
    if (pg?.code === '22023') throw new AppError(400, 'VALIDATION', pg.message ?? 'Invalid value');
    throw e;
  };

  // ─────────────────────────────────────────── overview

  app.get('/ops/overview', { preHandler: gate('ops.read') }, async (req) => {
    const ledger = holds(req, 'ledger.read');
    const kyc = holds(req, 'kyc.review');
    return app.opsTx(req, async (tx) => {
      const [c] = await tx<Record<string, number>[]>`
        SELECT
          (SELECT count(*) FROM dispute WHERE status IN ('open','evidence'))::int                       AS disputes_open,
          (SELECT count(*) FROM sos_case WHERE resolved_at IS NULL)::int                               AS sos_open,
          (SELECT count(*) FROM errand WHERE status::text = ANY(${LIVE}))::int                         AS errands_live,
          (SELECT count(*) FROM errand WHERE created_at > now() - interval '24 hours')::int            AS errands_24h,
          (SELECT count(*) FROM errand WHERE status = 'settled' AND updated_at > now() - interval '7 days')::int AS settled_7d,
          (SELECT COALESCE(sum(spent_cents), 0) FROM errand
            WHERE status = 'settled' AND updated_at > now() - interval '7 days')::bigint               AS gmv_7d_cents,
          (SELECT count(DISTINCT runner_id) FROM errand
            WHERE runner_id IS NOT NULL AND updated_at > now() - interval '7 days')::int               AS active_runners_7d,
          (SELECT count(*) FROM account WHERE role <> 'staff' AND created_at > now() - interval '7 days')::int AS signups_7d`;
      const series = await tx<{ day: string; created: number; settled: number; gmv_cents: number }[]>`
        SELECT to_char(d, 'YYYY-MM-DD') AS day,
               (SELECT count(*) FROM errand WHERE created_at >= d AND created_at < d + interval '1 day')::int AS created,
               (SELECT count(*) FROM errand WHERE status = 'settled' AND updated_at >= d AND updated_at < d + interval '1 day')::int AS settled,
               (SELECT COALESCE(sum(spent_cents), 0) FROM errand
                 WHERE status = 'settled' AND updated_at >= d AND updated_at < d + interval '1 day')::bigint AS gmv_cents
          FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') AS d
         ORDER BY d`;
      // kyc_case is invisible without kyc.review; report "unknown", not a false zero.
      const [k] = kyc ? await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kyc_case WHERE status IN ('submitted','in_review')` : [null];
      let money: Record<string, unknown> | null = null;
      if (ledger) {
        const [m] = await tx<Record<string, number>[]>`
          SELECT
            (SELECT COALESCE(sum(p.amount_cents), 0) FROM posting p JOIN posting_group g ON g.id = p.group_id
              WHERE p.account::text = ANY(${REVENUE}) AND g.created_at > now() - interval '7 days')::bigint  AS revenue_7d_cents,
            (SELECT COALESCE(sum(p.amount_cents), 0) FROM posting p JOIN posting_group g ON g.id = p.group_id
              WHERE p.account::text = ANY(${REVENUE}) AND g.created_at > now() - interval '30 days')::bigint AS revenue_30d_cents,
            (SELECT COALESCE(sum(amount_cents), 0) FROM posting WHERE account = 'escrow_hold')::bigint        AS escrow_held_cents,
            (SELECT count(*) FROM payout WHERE status = 'failed' AND created_at > now() - interval '7 days')::int AS payouts_failed_7d,
            (SELECT count(*) FROM payout WHERE status IN ('queued','sent'))::int                            AS payouts_pending`;
        const [recon] = await tx`SELECT ran_at, findings, paged FROM reconciliation_run ORDER BY ran_at DESC LIMIT 1`;
        money = { ...m, last_reconciliation: recon ?? null };
      }
      return { counts: { ...c, kyc_waiting: k ? k.n : null }, series, money };
    });
  });

  // ─────────────────────────────────────────── people

  app.get('/ops/accounts', { preHandler: gate('ops.read') }, async (req) => {
    const q = parse(z.object({
      q: z.string().trim().max(80).optional(),
      role: z.enum(['requester', 'runner', 'staff']).optional(),
      status: z.enum(['active', 'suspended']).optional(),
    }), req.query);
    // A number is matched exactly (after canonicalising), never by prefix: the console must
    // not become a way to enumerate who is registered.
    let byId: string | null = null, byMsisdn: string | null = null, byName: string | null = null;
    if (q.q) {
      if (UUID.test(q.q)) byId = q.q.toLowerCase();
      else if (/^[+\d\s()-]+$/.test(q.q) && (q.q.match(/\d/g) ?? []).length >= 4) {
        try { byMsisdn = cleanMsisdn(q.q); } catch { throw new AppError(400, 'VALIDATION', 'Enter a full Kenyan mobile number'); }
      } else byName = `%${likeEscape(q.q)}%`;
    }
    const rows = await app.opsTx(req, (tx) => tx<{ id: string; display_name: string; role: string; verification_tier: number;
                                                     created_at: Date; suspended_at: Date | null; msisdn: string; staff_grants: string[] }[]>`
      SELECT id, display_name, role, verification_tier, created_at, suspended_at, msisdn, staff_grants
        FROM account
       WHERE (${byId}::uuid IS NULL OR id = ${byId}::uuid)
         AND (${byMsisdn}::text IS NULL OR msisdn = ${byMsisdn})
         AND (${byName}::text IS NULL OR display_name ILIKE ${byName})
         AND (${q.role ?? null}::text IS NULL OR role::text = ${q.role ?? null})
         AND (${q.status ?? null}::text IS NULL
              OR (${q.status ?? null} = 'suspended') = (suspended_at IS NOT NULL))
       ORDER BY created_at DESC LIMIT 50`);
    return { data: rows.map(({ msisdn, ...r }) => ({ ...r, msisdn_masked: maskMsisdn(msisdn) })) };
  });

  app.get('/ops/accounts/:id', { preHandler: gate('ops.read') }, async (req) => {
    const { id } = ids(req.params, 'id');
    const audit = holds(req, 'audit.read');
    const kyc = holds(req, 'kyc.review');
    return app.opsTx(req, async (tx) => {
      const [a] = await tx<{ id: string; display_name: string; role: string; verification_tier: number; language: string;
                             created_at: Date; suspended_at: Date | null; msisdn: string; staff_grants: string[] }[]>`
        SELECT id, display_name, role, verification_tier, language, created_at, suspended_at, msisdn, staff_grants
          FROM account WHERE id = ${id}`;
      if (!a) throw notFound('Account not found');
      const [stats] = await tx<Record<string, number>[]>`
        SELECT
          (SELECT count(*) FROM errand WHERE requester_id = ${id})::int                       AS posted,
          (SELECT count(*) FROM errand WHERE requester_id = ${id} AND status = 'settled')::int AS posted_settled,
          (SELECT count(*) FROM errand WHERE runner_id = ${id})::int                          AS ran,
          (SELECT count(*) FROM errand WHERE runner_id = ${id} AND status = 'settled')::int   AS ran_settled,
          (SELECT count(*) FROM dispute WHERE raised_by = ${id})::int                         AS disputes_raised,
          (SELECT count(*) FROM dispute d JOIN errand e ON e.id = d.errand_id
            WHERE (e.requester_id = ${id} OR e.runner_id = ${id}) AND d.raised_by <> ${id})::int AS disputes_against,
          (SELECT count(*) FROM sos_case WHERE raised_by = ${id})::int                        AS sos_raised`;
      const errands = await tx`
        SELECT id, title, kind, status, created_at, spend_cap_cents, spent_cents,
               CASE WHEN requester_id = ${id} THEN 'requester' ELSE 'runner' END AS as_role
          FROM errand WHERE requester_id = ${id} OR runner_id = ${id}
         ORDER BY created_at DESC LIMIT 15`;
      const kycCases = kyc ? await tx`
        SELECT id, target_tier, status, created_at, reviewed_at FROM kyc_case WHERE account_id = ${id}
         ORDER BY created_at DESC LIMIT 5` : null;
      const trail = audit ? await tx`
        SELECT l.action, l.created_at, o.display_name AS actor_name, l.meta->>'reason' AS reason
          FROM audit_log l LEFT JOIN account o ON o.id = l.actor_id
         WHERE l.subject = ${id} ORDER BY l.created_at DESC LIMIT 20` : null;
      await opsAudit(req, tx, 'account.view', id);
      const { msisdn, ...rest } = a;
      return { ...rest, msisdn_masked: maskMsisdn(msisdn), stats, errands, kyc_cases: kycCases, audit: trail };
    });
  });

  app.post('/ops/accounts/:id/suspend', { preHandler: gate('accounts.manage') }, async (req) => {
    const { id } = ids(req.params, 'id');
    const { reason } = parse(Suspension, req.body);
    return app.opsTx(req, async (tx) => {
      const moved = await tx`UPDATE account SET suspended_at = now(), updated_at = now()
                              WHERE id = ${id} AND suspended_at IS NULL RETURNING id`.catch(refuse);
      if (moved.length === 0) {
        const [exists] = await tx`SELECT 1 FROM account WHERE id = ${id}`;
        if (!exists) throw notFound('Account not found');
        throw new AppError(409, 'ALREADY_SUSPENDED', 'This account is already suspended');
      }
      // Signed out everywhere, now: refresh refuses a suspended account, and this ends the
      // sessions a still-valid access token is riding on (money paths and the socket check them).
      const [r] = await tx<{ n: number }[]>`SELECT app_revoke_account_sessions(${id}) AS n`;
      await opsAudit(req, tx, 'account.suspend', id, { reason, sessions_revoked: r!.n });
      await enqueueOutbox(tx, 'notify', { accountId: id, template: 'account.suspended', vars: {} });
      return { id, status: 'suspended', sessions_revoked: r!.n };
    });
  });

  app.post('/ops/accounts/:id/reinstate', { preHandler: gate('accounts.manage') }, async (req) => {
    const { id } = ids(req.params, 'id');
    const { reason } = parse(Suspension, req.body);
    return app.opsTx(req, async (tx) => {
      const moved = await tx`UPDATE account SET suspended_at = NULL, updated_at = now()
                              WHERE id = ${id} AND suspended_at IS NOT NULL RETURNING id`.catch(refuse);
      if (moved.length === 0) throw new AppError(409, 'NOT_SUSPENDED', 'This account is not suspended');
      await opsAudit(req, tx, 'account.reinstate', id, { reason });
      await enqueueOutbox(tx, 'notify', { accountId: id, template: 'account.reinstated', vars: {} });
      return { id, status: 'active' };
    });
  });

  /** Replace a staff account's grants. Takes effect at that officer's next token refresh. */
  app.put('/ops/accounts/:id/grants', { preHandler: gate('staff.admin') }, async (req) => {
    const { id } = ids(req.params, 'id');
    const { grants } = parse(StaffGrants, req.body);
    const next = [...new Set(grants)].sort();
    return app.opsTx(req, async (tx) => {
      const [a] = await tx<{ role: string; staff_grants: string[] }[]>`SELECT role, staff_grants FROM account WHERE id = ${id} FOR UPDATE`;
      if (!a) throw notFound('Account not found');
      if (a.role !== 'staff') throw new AppError(409, 'NOT_STAFF', 'Make this account staff first');
      await tx`UPDATE account SET staff_grants = ${next}, updated_at = now() WHERE id = ${id}`.catch(refuse);
      await opsAudit(req, tx, 'staff.grants', id, { before: a.staff_grants, after: next });
      return { id, grants: next };
    });
  });

  /** Promote a customer account to staff. One-way: staff accounts never become customers. */
  app.post('/ops/accounts/:id/make-staff', { preHandler: gate('staff.admin') }, async (req) => {
    const { id } = ids(req.params, 'id');
    const { grants } = parse(StaffGrants, req.body);
    const next = [...new Set(grants)].sort();
    return app.opsTx(req, async (tx) => {
      const [a] = await tx<{ role: string; suspended_at: Date | null }[]>`
        SELECT role, suspended_at FROM account WHERE id = ${id} FOR UPDATE`;
      if (!a) throw notFound('Account not found');
      if (a.role === 'staff') throw new AppError(409, 'ALREADY_STAFF', 'This account is already staff');
      if (a.suspended_at) throw new AppError(409, 'SUSPENDED', 'Reinstate the account first');
      // A customer mid-errand would lose the errand's role the moment they became staff.
      const [live] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM errand
         WHERE (requester_id = ${id} OR runner_id = ${id}) AND NOT (status::text = ANY(${[...TERMINAL, 'draft']}))`;
      if (live!.n > 0) throw new AppError(409, 'LIVE_ERRANDS', 'This account has errands in progress');
      await tx`UPDATE account SET role = 'staff', staff_grants = ${next}, updated_at = now() WHERE id = ${id}`.catch(refuse);
      await opsAudit(req, tx, 'staff.promote', id, { grants: next });
      return { id, role: 'staff', grants: next };
    });
  });

  // ─────────────────────────────────────────── SOS

  app.get('/ops/sos', { preHandler: gate('ops.read') }, async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'resolved']).default('open') }), req.query);
    const rows = await app.opsTx(req, (tx) => tx`
      SELECT s.id, s.errand_id, s.raised_by, s.lat, s.lng, s.created_at, s.acknowledged_at, s.resolved_at,
             s.resolution_note, e.title, e.status AS errand_status,
             r.display_name AS raised_by_name,
             CASE WHEN s.raised_by = e.requester_id THEN 'requester' ELSE 'runner' END AS raised_by_role,
             ack.display_name AS acknowledged_by_name, res.display_name AS resolved_by_name,
             extract(epoch FROM now() - s.created_at)::int AS age_seconds
        FROM sos_case s JOIN errand e ON e.id = s.errand_id JOIN account r ON r.id = s.raised_by
        LEFT JOIN account ack ON ack.id = s.acknowledged_by LEFT JOIN account res ON res.id = s.resolved_by
       WHERE (s.resolved_at IS NULL) = ${q.status === 'open'}
       -- Open: oldest first (the longest wait is the most urgent). Resolved: most recent first.
       ORDER BY CASE WHEN ${q.status === 'open'} THEN s.created_at END ASC, s.resolved_at DESC
       LIMIT 100`);
    return { data: rows };
  });

  app.post('/ops/sos/:id/acknowledge', { preHandler: gate('ops.read') }, async (req) => {
    const { id } = ids(req.params, 'id');
    return app.opsTx(req, async (tx) => {
      const moved = await tx`UPDATE sos_case SET acknowledged_at = now(), acknowledged_by = ${req.actor!.id}
                              WHERE id = ${id} AND acknowledged_at IS NULL AND resolved_at IS NULL RETURNING id`;
      if (moved.length === 0) throw new AppError(409, 'SOS_HANDLED', 'Already acknowledged or resolved');
      await opsAudit(req, tx, 'sos.acknowledge', id);
      return { id, status: 'acknowledged' };
    });
  });

  app.post('/ops/sos/:id/resolve', { preHandler: gate('ops.read') }, async (req) => {
    const { id } = ids(req.params, 'id');
    const { note } = parse(SosResolve, req.body);
    return app.opsTx(req, async (tx) => {
      const moved = await tx`
        UPDATE sos_case SET resolved_at = now(), resolved_by = ${req.actor!.id}, resolution_note = ${note},
               acknowledged_at = COALESCE(acknowledged_at, now()), acknowledged_by = COALESCE(acknowledged_by, ${req.actor!.id})
         WHERE id = ${id} AND resolved_at IS NULL RETURNING id`;
      if (moved.length === 0) throw new AppError(409, 'SOS_HANDLED', 'Already resolved');
      await opsAudit(req, tx, 'sos.resolve', id);
      return { id, status: 'resolved' };
    });
  });

  // ─────────────────────────────────────────── errands

  app.get('/ops/errands', { preHandler: gate('ops.read') }, async (req) => {
    const q = parse(z.object({
      status: z.enum(['live', 'disputed', 'settled', 'closed', 'all']).default('live'),
      q: z.string().trim().max(80).optional(),
    }), req.query);
    const statuses = q.status === 'live' ? LIVE : q.status === 'disputed' ? ['disputed'] : q.status === 'settled' ? ['settled']
      : q.status === 'closed' ? ['cancelled', 'expired'] : null;
    const byId = q.q && UUID.test(q.q) ? q.q.toLowerCase() : null;
    const byTitle = q.q && !byId ? `%${likeEscape(q.q)}%` : null;
    const rows = await app.opsTx(req, (tx) => tx`
      SELECT e.id, e.title, e.kind, e.status, e.created_at, e.updated_at, e.spend_cap_cents, e.spent_cents,
             e.agreed_fee_cents, rq.display_name AS requester_name, rn.display_name AS runner_name,
             e.requester_id, e.runner_id
        FROM errand e JOIN account rq ON rq.id = e.requester_id LEFT JOIN account rn ON rn.id = e.runner_id
       WHERE (${statuses}::text[] IS NULL OR e.status::text = ANY(${statuses}::text[]))
         AND (${byId}::uuid IS NULL OR e.id = ${byId}::uuid)
         AND (${byTitle}::text IS NULL OR e.title ILIKE ${byTitle})
       ORDER BY e.updated_at DESC LIMIT 100`);
    return { data: rows };
  });

  // ─────────────────────────────────────────── finance

  app.get('/ops/finance', { preHandler: gate('ledger.read') }, async (req: FastifyRequest) => app.opsTx(req, async (tx) => {
    const balances = await tx<{ account: string; balance_cents: number }[]>`
      SELECT account::text, COALESCE(sum(amount_cents), 0)::bigint AS balance_cents
        FROM posting GROUP BY account ORDER BY account`;
    const payouts = await tx<{ status: string; n: number; cents: number }[]>`
      SELECT status::text, count(*)::int AS n, COALESCE(sum(amount_cents), 0)::bigint AS cents
        FROM payout WHERE created_at > now() - interval '30 days' GROUP BY status`;
    const payments = await tx<{ rail: string; direction: string; status: string; n: number; cents: number }[]>`
      SELECT rail::text, direction, status::text, count(*)::int AS n, COALESCE(sum(amount_cents), 0)::bigint AS cents
        FROM payment WHERE created_at > now() - interval '30 days' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    const failures = await tx`
      (SELECT 'payout' AS kind, p.id, p.amount_cents, p.failure_code, p.created_at, a.display_name AS who, p.errand_id
         FROM payout p JOIN account a ON a.id = p.runner_id WHERE p.status = 'failed'
        ORDER BY p.created_at DESC LIMIT 10)
      UNION ALL
      (SELECT 'payment', p.id, p.amount_cents, p.failure_code, p.created_at, a.display_name, p.errand_id
         FROM payment p JOIN account a ON a.id = p.account_id WHERE p.status = 'failed'
        ORDER BY p.created_at DESC LIMIT 10)
      ORDER BY created_at DESC LIMIT 15`;
    const recon = await tx`
      SELECT id, ran_at, checks_run, findings, paged, duration_ms, detail FROM reconciliation_run ORDER BY ran_at DESC LIMIT 10`;
    await opsAudit(req, tx, 'finance.view', 'ledger');
    return { balances, payouts, payments, failures, reconciliation: recon };
  }));
}
