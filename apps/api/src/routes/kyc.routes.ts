// apps/api/src/routes/kyc.routes.ts
// Tiered verification (04-api.md §KYC). Documents go straight from the phone to storage on a
// five-minute presigned PUT for a key the server built; the API never handles the bytes and
// never accepts a client filename. Identity fields are sealed before they reach the database.

import type { FastifyInstance } from 'fastify';
import { CreateKycCase, PresignDocument, SubmitKyc, type KycCase } from '@sidequest/contracts';
import { kycObjectKey, cleanName, cleanMsisdn } from '@sidequest/domain/text/sanitize';
import { AppError, notFound } from '../plugins/errors.js';
import { LIMITS } from '../plugins/rate-limit.js';
import { parse, ids } from '../lib/validate.js';
import { seal } from '../lib/seal.js';

const SLOT_COLUMN = {
  id_front: 'id_front_key', id_back: 'id_back_key', selfie: 'selfie_key', conduct_cert: 'conduct_cert_key',
} as const;

interface CaseRow {
  id: string; account_id: string; target_tier: number; status: string; reject_reason: string | null;
  id_front_key: string | null; id_back_key: string | null; selfie_key: string | null;
  conduct_cert_key: string | null; next_of_kin_enc: Buffer | null; id_number_enc: Buffer | null;
  movement_consent: boolean; created_at: Date;
}

function view(c: CaseRow): KycCase {
  return {
    id: c.id,
    target_tier: c.target_tier,
    status: c.status,
    reject_reason: c.reject_reason,
    slots: {
      id_front: Boolean(c.id_front_key), id_back: Boolean(c.id_back_key), selfie: Boolean(c.selfie_key),
      ...(c.target_tier === 3 ? { conduct_cert: Boolean(c.conduct_cert_key) } : {}),
    },
    created_at: c.created_at.toISOString(),
  };
}

export default async function kycRoutes(app: FastifyInstance) {
  const { cfg, storage } = app.deps;

  app.post('/kyc/cases', {
    preHandler: [app.requireAuth, app.idempotent, app.limit(LIMITS.kycSubmit)],
  }, async (req, reply) => {
    const { target_tier } = parse(CreateKycCase, req.body);
    if (target_tier <= req.actor!.tier) throw new AppError(409, 'ALREADY_VERIFIED', `You are already tier ${req.actor!.tier}`);
    const c = await app.tx(req, async (tx) => {
      const open = await tx`SELECT id FROM kyc_case WHERE account_id = ${req.actor!.id} AND status IN ('unsubmitted','submitted','in_review')`;
      if (open.length) throw new AppError(409, 'CASE_OPEN', 'You already have a verification in progress');
      const [row] = await tx<CaseRow[]>`
        INSERT INTO kyc_case (account_id, target_tier) VALUES (${req.actor!.id}, ${target_tier}) RETURNING *`;
      return row!;
    });
    return reply.code(201).send(view(c));
  });

  app.post('/kyc/cases/:id/documents', {
    preHandler: [app.requireAuth, app.limit(LIMITS.presign)],
  }, async (req) => {
    const { id } = ids(req.params, 'id');
    const { slot, content_type } = parse(PresignDocument, req.body);
    const ext = content_type === 'image/png' ? 'png' : content_type === 'application/pdf' ? 'pdf' : 'jpg';

    const key = await app.tx(req, async (tx) => {
      const [c] = await tx<CaseRow[]>`SELECT * FROM kyc_case WHERE id = ${id}`;
      if (!c) throw notFound('Case not found');   // RLS: another account's case is simply absent
      if (c.status !== 'unsubmitted') throw new AppError(409, 'CASE_LOCKED', 'This case has been submitted');
      if (slot === 'conduct_cert' && c.target_tier < 3) throw new AppError(400, 'VALIDATION', 'Conduct certificate is for tier 3 only');
      const k = kycObjectKey(req.actor!.id, c.id, slot, ext);
      // Column name comes from a closed map, never from input.
      await tx`UPDATE kyc_case SET ${tx({ [SLOT_COLUMN[slot]]: k })} WHERE id = ${id}`;
      return k;
    });

    const put = await storage.presignPut(key, content_type, cfg.PRESIGN_TTL_SECONDS);
    return { upload_url: put.url, object_key: key, expires_in: put.expiresIn, headers: put.headers };
  });

  app.post('/kyc/cases/:id/submit', {
    preHandler: [app.requireAuth, app.limit(LIMITS.kycSubmit)],
  }, async (req) => {
    const { id } = ids(req.params, 'id');
    const body = parse(SubmitKyc, req.body);

    const c = await app.tx(req, async (tx) => {
      const [c] = await tx<CaseRow[]>`SELECT * FROM kyc_case WHERE id = ${id}`;
      if (!c) throw notFound('Case not found');
      if (c.status !== 'unsubmitted') throw new AppError(409, 'CASE_LOCKED', 'This case has been submitted');

      const missing: string[] = [];
      if (!c.id_front_key) missing.push('id_front');
      if (!c.id_back_key) missing.push('id_back');
      if (!c.selfie_key) missing.push('selfie');
      if (!body.id_number && !c.id_number_enc) missing.push('id_number');
      if (c.target_tier === 3) {
        if (!c.conduct_cert_key) missing.push('conduct_cert');
        if (!body.next_of_kin && !c.next_of_kin_enc) missing.push('next_of_kin');
        if (body.movement_consent !== true && !c.movement_consent) missing.push('movement_consent');
      }
      if (missing.length) throw new AppError(400, 'KYC_INCOMPLETE', 'Some requirements are missing', { missing });

      const idEnc = body.id_number ? seal(body.id_number, cfg.KYC_ENCRYPTION_KEY, cfg.KYC_ENCRYPTION_KEY_ID) : c.id_number_enc;
      let kinEnc = c.next_of_kin_enc;
      if (body.next_of_kin) {
        const kin = { name: cleanName('next_of_kin', body.next_of_kin.name), msisdn: cleanMsisdn(body.next_of_kin.msisdn) };
        kinEnc = seal(JSON.stringify(kin), cfg.KYC_ENCRYPTION_KEY, cfg.KYC_ENCRYPTION_KEY_ID);
      }
      const [row] = await tx<CaseRow[]>`
        UPDATE kyc_case SET status = 'submitted', id_number_enc = ${idEnc}, next_of_kin_enc = ${kinEnc},
               movement_consent = ${c.target_tier === 3 ? true : c.movement_consent},
               movement_consent_at = ${c.target_tier === 3 ? new Date() : null}
         WHERE id = ${id} RETURNING *`;
      return row!;
    });
    return view(c);
  });

  app.get('/kyc/cases/mine', { preHandler: app.requireAuth }, async (req) => {
    const rows = await app.tx(req, (tx) => tx<CaseRow[]>`
      SELECT * FROM kyc_case WHERE account_id = ${req.actor!.id} ORDER BY created_at DESC LIMIT 1`);
    return rows[0] ? view(rows[0]) : null;
  });

  app.get('/kyc/cases/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = ids(req.params, 'id');
    const [c] = await app.tx(req, (tx) => tx<CaseRow[]>`SELECT * FROM kyc_case WHERE id = ${id}`);
    if (!c) throw notFound('Case not found');
    return view(c);
  });
}
