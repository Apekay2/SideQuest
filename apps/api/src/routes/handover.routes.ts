// apps/api/src/routes/handover.routes.ts
// Goods handover (04-api.md). The requester's screen shows a server-issued QR token that
// rotates every 60 seconds; the runner scans it, which releases the task and writes the logs
// back. The link handshake has nothing to do with this — it governs location, not release.
//
// Token = base64url(step ‖ HMAC(HANDOVER_SECRET, errand_id ‖ step)). One step of grace either
// side absorbs a clock at the edge of a rotation. It is single-use by construction: the scan
// is a conditional UPDATE from `handover`, and a second scan finds the errand settled.

import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Handover, type HandoverToken } from '@sidequest/contracts';
import { nextStatus } from '@sidequest/domain/errand/machine';
import { enqueueOutbox } from '@sidequest/db';
import { AppError } from '../plugins/errors.js';
import { parse, ids } from '../lib/validate.js';
import { lockErrand, readErrand, assertRequester, assertRunner } from '../lib/errands.js';

const STEP_MS = 60_000;

export function handoverToken(secret: string, errandId: string, step: number): string {
  const mac = createHmac('sha256', secret).update(`${errandId}:${step}`).digest().subarray(0, 16);
  const buf = Buffer.alloc(8 + mac.length);
  buf.writeBigUInt64BE(BigInt(step));
  mac.copy(buf, 8);
  return buf.toString('base64url');
}

export function verifyHandoverToken(secret: string, errandId: string, token: string, now = Date.now()): boolean {
  let buf: Buffer;
  try { buf = Buffer.from(token, 'base64url'); } catch { return false; }
  if (buf.length !== 24) return false;
  const step = Number(buf.readBigUInt64BE(0));
  const current = Math.floor(now / STEP_MS);
  if (step < current - 1 || step > current + 1) return false;
  const want = Buffer.from(handoverToken(secret, errandId, step), 'base64url');
  return timingSafeEqual(want, buf);
}

export default async function handoverRoutes(app: FastifyInstance) {
  const secret = app.deps.cfg.HANDOVER_SECRET;

  app.get('/errands/:id/handover-token', { preHandler: app.requireRole('requester') }, async (req): Promise<HandoverToken> => {
    const { id } = ids(req.params, 'id');
    const e = await app.tx(req, (tx) => readErrand(tx, id));
    assertRequester(e, req.actor!.id);
    if (e.status !== 'handover') throw new AppError(409, 'ERRAND_STATE_INVALID', 'The goods are not ready for handover yet');
    const now = Date.now();
    const step = Math.floor(now / STEP_MS);
    return {
      qr_token: handoverToken(secret, id, step),
      expires_at: new Date((step + 1) * STEP_MS).toISOString(),
      rotates_in_ms: (step + 1) * STEP_MS - now,
    };
  });

  app.post('/errands/:id/handover', {
    preHandler: [app.requireRole('runner'), app.limit({ name: 'handover', max: 10, windowSeconds: 600, by: 'account+errand', onRedisDown: 'deny' })],
  }, async (req) => {
    const { id } = ids(req.params, 'id');
    const { qr_token } = parse(Handover, req.body);

    const e = await app.tx(req, async (tx) => {
      const e = await lockErrand(tx, id);
      assertRunner(e, req.actor!.id);
      if (!verifyHandoverToken(secret, id, qr_token)) {
        throw new AppError(400, 'QR_INVALID', 'That code has expired or is not for this errand. Ask for a fresh one.');
      }
      const to = nextStatus(e.status, 'handover_scanned', 'runner');
      const moved = await tx`
        UPDATE errand SET status = ${to}, handover_at = now(), updated_at = now()
         WHERE id = ${id} AND status = 'handover' RETURNING id`;
      if (moved.length === 0) throw new AppError(409, 'ERRAND_STATE_INVALID', 'Already handed over');
      await tx`INSERT INTO errand_checkpoint (errand_id, kind, reached_at) VALUES (${id}, 'handover', now())`;
      // Settlement, the card void and the link revocation are money- and location-service
      // work; they follow from this commit through the outbox, never from the scan request.
      await enqueueOutbox(tx, 'errand.settle', { errandId: id });
      await enqueueOutbox(tx, 'card.void', { errandId: id });
      await enqueueOutbox(tx, 'link.revoke', { errandId: id });
      await enqueueOutbox(tx, 'notify', { accountId: e.requester_id, template: 'errand.handed_over', vars: { errandId: id } });
      return e;
    });

    await app.publish(e.requester_id, 'errand.handed_over', { errand_id: id });
    return { errand_id: id, status: 'settled' };
  });
}
