// Legal obligations in code: agreement before an account exists, re-agreement when the terms
// change before anything else changes data, with SOS never held back.

import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { randomInt } from 'node:crypto';
import { LEGAL_VERSIONS } from '@sidequest/contracts';
import { World, marketRun } from './world.js';

let w: World;
beforeAll(async () => { w = await new World().start(); });
afterAll(async () => { await w.stop(); });

const number = () => `07${randomInt(10_000_000, 99_999_999)}`;
async function verify(msisdn: string, extra: Record<string, unknown>) {
  const anon = w.anon();
  const otp = await anon.post('/auth/otp', { msisdn }, { idem: false });
  const code = /(\d{6})/.exec(w.sms().outbox.at(-1)!.text)![1]!;
  return anon.post('/auth/verify', { challenge_id: otp.body.challenge_id, code, role: 'requester', display_name: 'Legal Test', ...extra }, { idem: false });
}

describe('agreement before an account exists', () => {
  test('no acceptance, an old version, or no 18+ confirmation: no account is created', async () => {
    for (const extra of [{}, { accept_legal: { ...LEGAL_VERSIONS, terms: '2020-01-01', adult: true } }, { accept_legal: { ...LEGAL_VERSIONS, adult: false } }]) {
      const n = number();
      const r = await verify(n, extra);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
      const [row] = await w.admin`SELECT count(*)::int AS n FROM account WHERE msisdn = ${`+254${n.slice(1)}`}`;
      expect(row!.n).toBe(0);
    }
  });

  test('accepting records both documents with the version, the 18+ confirmation and the time', async () => {
    const r = await verify(number(), { accept_legal: { ...LEGAL_VERSIONS, adult: true } });
    expect(r.status).toBe(200);
    expect(r.body.account.legal_current).toBe(true);
    const rows = await w.admin`SELECT document, version, adult FROM legal_acceptance WHERE account_id = ${r.body.account.id} ORDER BY document`;
    expect(rows).toEqual([
      { document: 'privacy', version: LEGAL_VERSIONS.privacy, adult: true },
      { document: 'terms', version: LEGAL_VERSIONS.terms, adult: true },
    ]);
  });
});

describe('when the terms change', () => {
  test('reads still work, changes are refused, SOS is never blocked; accepting restores everything', async () => {
    const req = await w.requester('Outdated Olive');
    const run = await w.runner('SOS Runner');
    await w.topUp(req, 400_000);
    const e = (await req.client.post('/errands', marketRun())).body;
    await req.client.post(`/errands/${e.id}/publish`);
    await req.client.post(`/errands/${e.id}/fund`, { rail: 'wallet' });
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 30_000 });
    await run.client.post(`/errands/${e.id}/accept`);
    await w.settle();

    // As if the documents were re-versioned after this person accepted.
    await w.admin`DELETE FROM legal_acceptance WHERE account_id = ${req.id}`;
    await w.refresh(req);
    expect((await req.client.get('/me')).body.legal_current).toBe(false);
    expect((await req.client.get('/wallet')).status).toBe(200);
    const blocked = await req.client.post('/wallet/topup', { amount_cents: 10_000 });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    expect((await req.client.post(`/errands/${e.id}/sos`, { lat: -1.29, lng: 36.78 })).status).toBe(201);

    expect((await req.client.post('/me/legal', { terms: '2020-01-01', privacy: LEGAL_VERSIONS.privacy, adult: true })).status).toBe(400);
    expect((await req.client.post('/me/legal', { ...LEGAL_VERSIONS, adult: true })).status).toBe(204);
    await w.refresh(req);
    expect((await req.client.get('/me')).body.legal_current).toBe(true);
    expect((await req.client.post('/wallet/topup', { amount_cents: 10_000 })).status).toBe(202);
  });

  test('staff are not party to the consumer terms and are never blocked by them', async () => {
    const officer = await w.staff(['ops.read', 'accounts.manage']);
    await w.admin`DELETE FROM legal_acceptance WHERE account_id = ${officer.id}`;
    await w.refresh(officer);
    const u = await w.requester('Staff Target');
    expect((await officer.client.post(`/ops/accounts/${u.id}/suspend`, { reason: 'Testing the staff exemption' })).status).toBe(200);
  });
});
