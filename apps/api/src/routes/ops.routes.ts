// apps/api/src/routes/ops.routes.ts
// The ops console's API (04-api.md §Ops). Separate pool, separate role (sidequest_ops), and
// entitlement-gated policies in 0003/0006 — not the app role with extra permissions. Every
// read of evidence, KYC documents or a money trace writes an audit row. Requests are also
// source-restricted to OPS_IP_ALLOWLIST (§7.2 insider controls).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KycDecision, Ruling } from '@sidequest/contracts';
import { csvCell, cleanProse } from '@sidequest/domain/text/sanitize';
import { enqueueOutbox, type Tx } from '@sidequest/db';
import { AppError, notFound } from '../plugins/errors.js';
import { parse, ids } from '../lib/validate.js';
import { open as openSealed } from '../lib/seal.js';
import { opsGate, opsAudit, holds } from '../lib/ops.js';

export default async function opsRoutes(app: FastifyInstance) {
  const { cfg, storage } = app.deps;

  const gate = opsGate(app);

  // What escrow holds for an errand, from the ledger: the number a ruling must split exactly.
  const heldCents = async (tx: Tx, errandId: string) => {
    const [r] = await tx<{ held: number }[]>`
      SELECT COALESCE(sum(p.amount_cents), 0)::bigint AS held FROM posting p JOIN posting_group g ON g.id = p.group_id
       WHERE g.errand_id = ${errandId} AND p.account = 'escrow_hold'`;
    return r!.held;
  };

  const canSeeLedger = (req: FastifyRequest) => holds(req, 'ledger.read');
  const audit = opsAudit;

  // ─────────────────────────────────────────── KYC

  app.get('/ops/kyc', { preHandler: gate('kyc.review') }, async (req) => {
    const q = parse(z.object({ status: z.enum(['submitted', 'in_review', 'approved', 'rejected']).default('submitted') }), req.query);
    const rows = await app.opsTx(req, (tx) => tx`
      SELECT k.id, k.account_id, a.display_name, a.role, a.verification_tier, k.target_tier, k.status,
             k.created_at, k.reviewed_at, k.reject_reason,
             extract(epoch FROM now() - k.created_at)::int AS age_seconds
        FROM kyc_case k JOIN account a ON a.id = k.account_id
       WHERE k.status = ${q.status}
       ORDER BY k.created_at ASC LIMIT 100`);
    return { data: rows };
  });

  app.get('/ops/kyc/:id', { preHandler: gate('kyc.review') }, async (req) => {
    const { id } = ids(req.params, 'id');
    const c = await app.opsTx(req, async (tx) => {
      const [c] = await tx<{ id: string; account_id: string; display_name: string; target_tier: number; status: string;
                             id_front_key: string | null; id_back_key: string | null; selfie_key: string | null;
                             conduct_cert_key: string | null; id_number_enc: Buffer | null; next_of_kin_enc: Buffer | null;
                             movement_consent: boolean; created_at: Date }[]>`
        SELECT k.*, a.display_name FROM kyc_case k JOIN account a ON a.id = k.account_id WHERE k.id = ${id}`;
      if (!c) throw notFound('Case not found');
      await audit(req, tx, 'kyc.view', id);
      return c;
    });
    const keys = { [cfg.KYC_ENCRYPTION_KEY_ID]: cfg.KYC_ENCRYPTION_KEY };
    const docs: Record<string, string | null> = {};
    for (const slot of ['id_front', 'id_back', 'selfie', 'conduct_cert'] as const) {
      const k = c[`${slot}_key`];
      docs[slot] = k ? await storage.presignGet(k, 120) : null;
    }
    const idNumber = c.id_number_enc ? openSealed(c.id_number_enc, keys) : null;
    const kin = c.next_of_kin_enc ? (JSON.parse(openSealed(c.next_of_kin_enc, keys)) as { name: string; msisdn: string }) : null;
    return {
      id: c.id, account_id: c.account_id, display_name: c.display_name, target_tier: c.target_tier, status: c.status,
      created_at: c.created_at, movement_consent: c.movement_consent, documents: docs,
      // Shown masked. The reviewer compares against the photographed ID, which is enough; the
      // full number is not needed on screen to decide.
      id_number_masked: idNumber ? `••••${idNumber.slice(-3)}` : null,
      next_of_kin: kin ? { name: kin.name, msisdn_masked: `…${kin.msisdn.slice(-3)}` } : null,
    };
  });

  app.post('/ops/kyc/:id/decide', { preHandler: gate('kyc.review') }, async (req) => {
    const { id } = ids(req.params, 'id');
    const body = parse(KycDecision, req.body);
    if (!body.approve && !body.reason) throw new AppError(400, 'VALIDATION', 'A rejection needs a reason the applicant will read');
    return app.opsTx(req, async (tx) => {
      const [c] = await tx<{ account_id: string; target_tier: number; status: string }[]>`
        SELECT account_id, target_tier, status FROM kyc_case WHERE id = ${id} FOR UPDATE`;
      if (!c) throw notFound('Case not found');
      if (c.status !== 'submitted' && c.status !== 'in_review') throw new AppError(409, 'CASE_DECIDED', 'This case has already been decided');
      if (c.account_id === req.actor!.id) throw new AppError(403, 'FORBIDDEN', 'You cannot review your own case');
      const tier = body.approve ? (body.tier ?? c.target_tier) : null;
      await tx`
        UPDATE kyc_case SET status = ${body.approve ? 'approved' : 'rejected'}, reviewed_by = ${req.actor!.id},
               reviewed_at = now(), reject_reason = ${body.reason ? cleanProse('reason', body.reason, 280) : null}
         WHERE id = ${id}`;
      if (tier !== null) {
        await tx`UPDATE account SET verification_tier = GREATEST(verification_tier, ${tier}), updated_at = now() WHERE id = ${c.account_id}`;
      }
      await audit(req, tx, body.approve ? 'kyc.approve' : 'kyc.reject', id, { tier });
      await enqueueOutbox(tx, 'notify', {
        accountId: c.account_id, template: body.approve ? 'kyc.approved' : 'kyc.rejected', vars: { tier },
      });
      return { id, status: body.approve ? 'approved' : 'rejected', tier };
    });
  });

  // ─────────────────────────────────────────── disputes

  app.get('/ops/disputes', { preHandler: gate('ops.read') }, async (req) => {
    // 'awaiting' is the ruling queue: a dispute moves from open to evidence as soon as the
    // worker freezes escrow, and a filter on 'open' alone would hide nearly all of them.
    const q = parse(z.object({ status: z.enum(['awaiting', 'open', 'evidence', 'ruled', 'closed']).default('awaiting') }), req.query);
    const statuses = q.status === 'awaiting' ? ['open', 'evidence'] : [q.status];
    const rows = await app.opsTx(req, (tx) => tx`
      SELECT d.id, d.errand_id, d.reason, d.status, d.created_at, e.title, e.kind, e.status AS errand_status,
             extract(epoch FROM now() - d.created_at)::int AS age_seconds,
             -- Postings are ledger.read under RLS; without it this would read as a false zero.
             CASE WHEN ${canSeeLedger(req)} THEN (SELECT COALESCE(sum(p.amount_cents), 0)::bigint FROM posting p JOIN posting_group g ON g.id = p.group_id
               WHERE g.errand_id = d.errand_id AND p.account = 'escrow_hold') END AS held_cents
        FROM dispute d JOIN errand e ON e.id = d.errand_id
       WHERE d.status::text = ANY(${statuses}::text[]) ORDER BY d.created_at ASC LIMIT 100`);
    return { data: rows };
  });

  /** Evidence pack. Each read writes an access audit row (04-api.md). */
  app.get('/ops/disputes/:id/evidence', { preHandler: gate('evidence.view') }, async (req) => {
    const { id } = ids(req.params, 'id');
    const pack = await app.opsTx(req, async (tx) => {
      const [d] = await tx<{ id: string; errand_id: string; reason: string; detail: string | null; raised_by: string; status: string; created_at: Date }[]>`
        SELECT * FROM dispute WHERE id = ${id}`;
      if (!d) throw notFound('Dispute not found');
      const [e] = await tx`SELECT id, title, kind, status, requester_id, runner_id, spend_cap_cents, spent_cents,
                                  agreed_fee_cents, bonus_cents, deadline_at, handover_at FROM errand WHERE id = ${d.errand_id}`;
      const evidence = await tx<{ id: string; stall_id: string | null; kind: string; object_key: string; attempt: number;
                                  rejected: boolean; taken_at: Date; lat: number | null; lng: number | null }[]>`
        SELECT id, stall_id, kind, object_key, attempt, rejected, taken_at,
               ST_Y(taken_at_geo::geometry) AS lat, ST_X(taken_at_geo::geometry) AS lng
          FROM evidence WHERE errand_id = ${d.errand_id} ORDER BY created_at`;
      const stalls = await tx`SELECT id, seq, name, status, total_cents FROM stall WHERE errand_id = ${d.errand_id} ORDER BY seq`;
      const items = await tx`SELECT i.stall_id, i.label, i.qty::text, i.unit, i.price_cents, i.accepted, i.substituted_for
                               FROM line_item i JOIN stall s ON s.id = i.stall_id WHERE s.errand_id = ${d.errand_id}`;
      const messages = await tx`SELECT sender_id, body, created_at FROM message WHERE errand_id = ${d.errand_id} ORDER BY created_at`;
      const held = canSeeLedger(req) ? await heldCents(tx, d.errand_id) : null;
      await audit(req, tx, 'dispute.evidence_view', id);
      return { d, e, evidence, stalls, items, messages, held };
    });
    return {
      dispute: pack.d,
      errand: pack.e,
      escrow_cents: pack.held,
      stalls: pack.stalls,
      items: pack.items,
      messages: pack.messages,
      evidence: await Promise.all(pack.evidence.map(async ({ object_key, ...ev }) => ({ ...ev, url: await storage.presignGet(object_key, 300) }))),
    };
  });

  /** The only path that splits a frozen escrow; requires legal_ops. */
  app.post('/ops/disputes/:id/rule', { preHandler: gate('legal_ops') }, async (req, reply) => {
    const { id } = ids(req.params, 'id');
    const body = parse(Ruling, req.body);
    const rationale = cleanProse('rationale', body.rationale, 4000);
    const ruling = await app.opsTx(req, async (tx) => {
      const [d] = await tx<{ errand_id: string; status: string }[]>`SELECT errand_id, status FROM dispute WHERE id = ${id} FOR UPDATE`;
      if (!d) throw notFound('Dispute not found');
      if (d.status === 'ruled' || d.status === 'closed') throw new AppError(409, 'ALREADY_RULED', 'This dispute has been ruled');
      const [e] = await tx<{ requester_id: string; runner_id: string | null }[]>`SELECT requester_id, runner_id FROM errand WHERE id = ${d.errand_id}`;
      if (e!.requester_id === req.actor!.id || e!.runner_id === req.actor!.id) {
        throw new AppError(403, 'FORBIDDEN', 'You cannot rule on an errand you are party to');
      }
      // The split must equal what escrow holds. The worker checks again against the ledger
      // before posting, and parks the ruling for a human if the two disagree.
      const held = await heldCents(tx, d.errand_id);
      if (body.requester_cents + body.runner_cents !== held) {
        throw new AppError(400, 'SPLIT_MISMATCH', 'The split must add up to the frozen escrow', { escrow_cents: held });
      }
      if (!e!.runner_id && body.runner_cents > 0) throw new AppError(400, 'VALIDATION', 'There is no runner to pay');
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO ruling (dispute_id, officer_id, outcome, requester_cents, runner_cents, rationale)
        VALUES (${id}, ${req.actor!.id}, ${body.outcome}, ${body.requester_cents}, ${body.runner_cents}, ${rationale})
        RETURNING id`;
      await tx`UPDATE dispute SET status = 'ruled' WHERE id = ${id}`;
      await enqueueOutbox(tx, 'dispute.ruled', { disputeId: id, rulingId: r!.id, errandId: d.errand_id });
      await audit(req, tx, 'dispute.rule', id, { outcome: body.outcome });
      return r!;
    });
    return reply.code(201).send({ id: ruling.id });
  });

  app.get('/ops/rulings', { preHandler: gate('ops.read') }, async (req) => {
    const rows = await app.opsTx(req, (tx) => tx`
      SELECT r.id, r.dispute_id, r.officer_id, o.display_name AS officer_name, r.outcome, r.requester_cents,
             r.runner_cents, r.rationale, r.created_at, d.errand_id, d.reason
        FROM ruling r JOIN dispute d ON d.id = r.dispute_id JOIN account o ON o.id = r.officer_id
       ORDER BY r.created_at DESC LIMIT 200`);
    return { data: rows };
  });

  // ─────────────────────────────────────────── money trace

  app.get('/ops/errands/:id/trace', { preHandler: gate('ledger.read') }, async (req) => {
    const { id } = ids(req.params, 'id');
    return app.opsTx(req, async (tx) => {
      const [e] = await tx`SELECT * FROM errand WHERE id = ${id}`;
      if (!e) throw notFound('Errand not found');
      const postings = await tx`
        SELECT g.id AS group_id, g.reason, g.created_at, p.account, p.owner_id, p.amount_cents, p.fund_class
          FROM posting_group g JOIN posting p ON p.group_id = g.id WHERE g.errand_id = ${id} ORDER BY p.id`;
      const tranches = await tx`
        SELECT t.* FROM tranche t JOIN card c ON c.id = t.card_id WHERE c.errand_id = ${id} ORDER BY t.seq`;
      const attempts = await tx`
        SELECT a.* FROM card_attempt a JOIN tranche t ON t.id = a.tranche_id JOIN card c ON c.id = t.card_id
         WHERE c.errand_id = ${id} ORDER BY a.created_at`;
      const payments = await tx`SELECT id, rail, direction, amount_cents, status, provider_ref, created_at FROM payment WHERE errand_id = ${id}`;
      const [card] = await tx`SELECT id, issuer_ref, last4, loaded_cents, voided_at FROM card WHERE errand_id = ${id}`;
      const [escrow] = await tx`SELECT * FROM escrow WHERE errand_id = ${id}`;
      await audit(req, tx, 'errand.trace_view', id);
      return { errand: e, card: card ?? null, escrow: escrow ?? null, postings, tranches, attempts, payments };
    });
  });

  // Voiding a live card strands a runner mid-errand: a decision, not a read. Same entitlement
  // as a ruling, never ops.read.
  app.post('/ops/cards/:id/void', { preHandler: gate('legal_ops') }, async (req) => {
    const { id } = ids(req.params, 'id');
    await app.opsTx(req, async (tx) => {
      const [c] = await tx<{ errand_id: string }[]>`SELECT errand_id FROM card WHERE id = ${id}`;
      if (!c) throw notFound('Card not found');
      await enqueueOutbox(tx, 'card.void', { errandId: c.errand_id, manual: true });
      await audit(req, tx, 'card.void_manual', id);
    });
    return { card_id: id, status: 'void_requested' };
  });

  /** Accounts export for the ops team's spreadsheet. Every cell passes the formula guard. */
  app.get('/ops/export/accounts.csv', { preHandler: gate('ops.read') }, async (req, reply) => {
    const rows = await app.opsTx(req, async (tx) => {
      const r = await tx<{ id: string; display_name: string; role: string; verification_tier: number; created_at: Date }[]>`
        SELECT id, display_name, role, verification_tier, created_at FROM account ORDER BY created_at LIMIT 10000`;
      await audit(req, tx, 'accounts.export', 'account', { rows: r.length });
      return r;
    });
    const esc = (v: string) => `"${csvCell(v).replace(/"/g, '""')}"`;
    const lines = ['id,display_name,role,tier,created_at',
      ...rows.map((r) => [r.id, esc(r.display_name), r.role, r.verification_tier, r.created_at.toISOString()].join(','))];
    return reply.type('text/csv').header('Content-Disposition', 'attachment; filename="accounts.csv"').send(lines.join('\n'));
  });
}
