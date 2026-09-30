// apps/api/src/routes/safety.routes.ts
// Chat between the parties, SOS, and disputes. A pre-settlement dispute freezes the escrow;
// only Legal Operations can release it (ops.routes.ts).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SendMessage, Sos, OpenDispute, type Message } from '@sidequest/contracts';
import { marketOf } from '@sidequest/domain/money/currency';
import { canTransition, nextStatus } from '@sidequest/domain/errand/machine';
import { cleanProse } from '@sidequest/domain/text/sanitize';
import { enqueueOutbox } from '@sidequest/db';
import { AppError, notFound } from '../plugins/errors.js';
import { LIMITS } from '../plugins/rate-limit.js';
import { parse, ids } from '../lib/validate.js';
import { lockErrand, readErrand } from '../lib/errands.js';

const CHAT_CLOSES_AFTER_MS = 24 * 3600_000;

export default async function safetyRoutes(app: FastifyInstance) {
  // ─────────────────────────────────────────── chat

  app.get('/errands/:id/messages', { preHandler: app.requireAuth }, async (req) => {
    const { id } = ids(req.params, 'id');
    const q = parse(z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    const rows = await app.tx(req, (tx) => tx<{ id: string; sender_id: string; body: string; created_at: Date }[]>`
      SELECT id, sender_id, body, created_at FROM message
       WHERE errand_id = ${id} ${q.before ? tx`AND created_at < ${q.before}` : tx``}
       ORDER BY created_at DESC LIMIT ${q.limit}`);
    const data: Message[] = rows.map((r) => ({ id: r.id, sender_id: r.sender_id, body: r.body, at: r.created_at.toISOString() }));
    return { data, next_cursor: rows.length === q.limit ? rows[rows.length - 1]!.created_at.toISOString() : null };
  });

  app.post('/errands/:id/messages', { preHandler: [app.requireAuth, app.limit(LIMITS.writes)] }, async (req, reply) => {
    const { id } = ids(req.params, 'id');
    const body = cleanProse('body', parse(SendMessage, req.body).body, 1000);
    const out = await app.tx(req, async (tx) => {
      const e = await readErrand(tx, id);
      const other = e.requester_id === req.actor!.id ? e.runner_id : e.runner_id === req.actor!.id ? e.requester_id : null;
      if (!other) throw notFound('Errand not found');
      if (e.handover_at && Date.now() - e.handover_at.getTime() > CHAT_CLOSES_AFTER_MS) {
        throw new AppError(409, 'CHAT_CLOSED', 'This conversation closed 24 hours after handover');
      }
      const [m] = await tx<{ id: string; created_at: Date }[]>`
        INSERT INTO message (errand_id, sender_id, body) VALUES (${id}, ${req.actor!.id}, ${body}) RETURNING id, created_at`;
      await enqueueOutbox(tx, 'notify', { accountId: other, template: 'message.new', vars: { errandId: id } });
      return { message: { id: m!.id, sender_id: req.actor!.id, body, at: m!.created_at.toISOString() }, other };
    });
    await app.publish(out.other, 'message.new', { errand_id: id, message: out.message });
    return reply.code(201).send(out.message);
  });

  // ─────────────────────────────────────────── SOS

  /** Snapshots location and both identities, opens a case, returns the dial intent. */
  app.post('/errands/:id/sos', { preHandler: [app.requireAuth, app.limit(LIMITS.sos)] }, async (req, reply) => {
    const { id } = ids(req.params, 'id');
    const { lat, lng } = parse(Sos, req.body);
    const out = await app.tx(req, async (tx) => {
      const e = await readErrand(tx, id);
      if (e.requester_id !== req.actor!.id && e.runner_id !== req.actor!.id) throw notFound('Errand not found');
      const people = await tx<{ id: string; display_name: string; verification_tier: number }[]>`
        SELECT id, display_name, verification_tier FROM account WHERE id = ANY(${[e.requester_id, e.runner_id].filter(Boolean) as string[]}::uuid[])`;
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO sos_case (errand_id, raised_by, lat, lng, snapshot)
        VALUES (${id}, ${req.actor!.id}, ${lat ?? null}, ${lng ?? null},
                ${tx.json({ errand_status: e.status, people, raised_at: new Date().toISOString() } as never)})
        RETURNING id`;
      await enqueueOutbox(tx, 'sos.opened', { sosId: c!.id, errandId: id });
      return { id: c!.id, market: e.market };
    });
    // The emergency number comes from the market, not a literal: 999 is a Kenyan artefact.
    const emergency = marketOf(out.market).emergencyNumber;
    return reply.code(201).send({ sos_id: out.id, dial: `tel:${emergency}`, emergency_number: emergency });
  });

  // ─────────────────────────────────────────── disputes

  app.post('/disputes', { preHandler: [app.requireAuth, app.idempotent, app.limit(LIMITS.disputeCreate)] }, async (req, reply) => {
    const body = parse(OpenDispute, req.body);
    const detail = cleanProse('detail', body.detail, 2000);
    const d = await app.tx(req, async (tx) => {
      const e = await lockErrand(tx, body.errand_id);
      const by = e.requester_id === req.actor!.id ? 'requester' : e.runner_id === req.actor!.id ? 'runner' : null;
      if (!by) throw notFound('Errand not found');
      const open = await tx`SELECT 1 FROM dispute WHERE errand_id = ${e.id} AND status IN ('open','evidence')`;
      if (open.length) throw new AppError(409, 'DISPUTE_OPEN', 'There is already an open dispute on this errand');
      if (!canTransition(e.status, 'raise_dispute', by)) {
        throw new AppError(409, 'ERRAND_STATE_INVALID', 'This errand cannot be disputed now');
      }
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO dispute (errand_id, raised_by, reason, detail) VALUES (${e.id}, ${req.actor!.id}, ${body.reason}, ${detail})
        RETURNING id`;
      await tx`UPDATE errand SET status = ${nextStatus(e.status, 'raise_dispute', by)}, updated_at = now() WHERE id = ${e.id}`;
      // Freezing escrow and voiding the card are money-service writes (the runner cannot write
      // escrow under RLS); the outbox carries them in the same commit as the dispute itself.
      await enqueueOutbox(tx, 'dispute.opened', { disputeId: row!.id, errandId: e.id });
      const other = by === 'requester' ? e.runner_id : e.requester_id;
      if (other) await enqueueOutbox(tx, 'notify', { accountId: other, template: 'dispute.opened', vars: { errandId: e.id } });
      return row!;
    });
    return reply.code(201).send({ id: d.id, status: 'open' });
  });

  app.get('/disputes/mine', { preHandler: app.requireAuth }, async (req) => {
    const rows = await app.tx(req, (tx) => tx`
      SELECT d.id, d.errand_id, d.reason, d.status, d.created_at, r.outcome, r.requester_cents, r.runner_cents
        FROM dispute d LEFT JOIN ruling r ON r.dispute_id = d.id
       WHERE d.raised_by = ${req.actor!.id}
          OR EXISTS (SELECT 1 FROM errand e WHERE e.id = d.errand_id
                      AND (e.requester_id = ${req.actor!.id} OR e.runner_id = ${req.actor!.id}))
       ORDER BY d.created_at DESC LIMIT 50`);
    return { data: rows };
  });
}
