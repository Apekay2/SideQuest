// The data subject's rights (Kenya DPA 2019 s.26) and the retention schedule, end to end:
// access (export), erasure (in-app account deletion), revocable location consent, and the
// worker's purge of what has outlived its purpose — including the stored documents.

import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { LocalStorage } from '@sidequest/adapters';
import { retention } from '@sidequest/worker/jobs/retention';
import { World, marketRun } from './world.js';

let w: World;
let disk: LocalStorage;
beforeAll(async () => {
  w = await new World().start();
  disk = w.apiDeps.localStorage as LocalStorage;
});
afterAll(async () => { await w.stop(); });

const DELETE = { confirm: 'DELETE' };

async function storedKycDoc(accountId: string, status: 'approved' | 'rejected', reviewedDaysAgo = 0) {
  const key = `kyc/${accountId}/${randomUUID()}.jpg`;
  await disk.write(key, Buffer.from('id document'));
  await w.admin`INSERT INTO kyc_case (account_id, target_tier, status, id_front_key, reviewed_at)
                VALUES (${accountId}, 2, ${status}, ${key}, now() - make_interval(days => ${reviewedDaysAgo}))`;
  return key;
}

describe('access: a copy of my data', () => {
  test('returns what is held about me, and nothing about anyone else', async () => {
    const me = await w.requester('Export Esther');
    const other = await w.requester('Other Otto');
    await w.topUp(me, 50_000);
    const r = await me.client.get('/me/export');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/attachment/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.account).toMatchObject({ id: me.id, display_name: 'Export Esther', msisdn: me.msisdn });
    expect(r.body.legal_acceptances.map((a: any) => a.document).sort()).toEqual(['privacy', 'terms']);
    expect(r.body.payments).toHaveLength(1);
    expect(r.body.ledger.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toContain(other.id);
  });
});

describe('erasure: closing my account', () => {
  test('needs an explicit confirmation', async () => {
    const me = await w.requester();
    expect((await me.client.post('/me/delete', {})).status).toBe(400);
  });

  test('refused while money is still mine, so nothing owed is lost', async () => {
    const me = await w.requester();
    await w.topUp(me, 20_000);
    const r = await me.client.post('/me/delete', DELETE);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ACCOUNT_HAS_BALANCE');
    expect(r.body.details.wallet_cents).toBe(20_000);
  });

  test('refused while an errand is in progress', async () => {
    const me = await w.requester();
    const e = await me.client.post('/errands', marketRun());
    await w.admin`UPDATE errand SET status = 'open' WHERE id = ${e.body.id}`;
    const r = await me.client.post('/me/delete', DELETE);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('LIVE_ERRANDS');
  });

  test('staff accounts are closed by an admin, not by themselves', async () => {
    const s = await w.staff(['ops.read']);
    expect((await s.client.post('/me/delete', DELETE)).status).toBe(403);
  });

  test('erases identity, documents and sessions; keeps the ledger; frees the number', async () => {
    const me = await w.runner('Erased Ezra', 2);
    const key = await storedKycDoc(me.id, 'approved');
    expect(await disk.exists(key)).toBe(true);

    expect((await me.client.post('/me/delete', DELETE)).status).toBe(204);

    const acct = await w.one`SELECT display_name, msisdn, suspended_at FROM account WHERE id = ${me.id}`;
    expect(acct).toMatchObject({ display_name: 'Deleted user', msisdn: `erased:${me.id}` });
    expect(acct.suspended_at).not.toBeNull();
    expect((await w.one`SELECT count(*)::int AS n FROM kyc_case WHERE account_id = ${me.id}`).n).toBe(0);
    expect(await disk.exists(key)).toBe(false);
    expect((await w.one`SELECT kyc_objects FROM erasure_log WHERE account_id = ${me.id}`).kyc_objects).toBe(1);
    // Every session is gone: the refresh token no longer works.
    expect((await w.anon().post('/auth/refresh', { refresh: me.refresh }, { idem: false })).status).toBe(401);
    // The number can start afresh as a new account.
    const again = await w.signIn({ msisdn: `0${me.msisdn.slice(4)}` });
    expect(again.id).not.toBe(me.id);
  });
});

describe('location consent: given and withdrawn at will', () => {
  test('a runner can withdraw it, which stops sharing, and give it again', async () => {
    const run = await w.runner('Consent Cora');
    expect((await run.client.get('/me/location-consent')).body.consent).toBe(true);
    const presence = () => run.client.post('/presence', { lat: -1.27, lng: 36.81, available: true });
    expect((await presence()).status).toBe(204);

    expect((await run.client.post('/me/location-consent', { consent: false })).status).toBe(204);
    const off = await run.client.get('/me/location-consent');
    expect(off.body.consent).toBe(false);
    expect(Date.parse(off.body.changed_at)).toBeGreaterThan(Date.now() - 60_000);
    const refused = await presence();
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('CONSENT_REQUIRED');

    expect((await run.client.post('/me/location-consent', { consent: true })).status).toBe(204);
    expect((await presence()).status).toBe(204);
  });

  test('without tier-3 verification there is nothing to consent to', async () => {
    const req = await w.requester();
    expect((await req.client.get('/me/location-consent')).body).toEqual({ consent: null, changed_at: null });
    expect((await req.client.post('/me/location-consent', { consent: true })).body.code).toBe('TIER_REQUIRED');
  });
});

describe('retention schedule', () => {
  test('rejected KYC goes after 90 days with its documents; recent and approved cases stay', async () => {
    const a = await w.requester(), b = await w.requester(), c = await w.requester();
    const old = await storedKycDoc(a.id, 'rejected', 100);
    const recent = await storedKycDoc(b.id, 'rejected', 10);
    const approved = await storedKycDoc(c.id, 'approved', 400);

    await retention(w.worker.sql, w.worker.storage);

    expect(await disk.exists(old)).toBe(false);
    expect(await disk.exists(recent)).toBe(true);
    expect(await disk.exists(approved)).toBe(true);
    expect((await w.one`SELECT count(*)::int AS n FROM kyc_case WHERE account_id = ${a.id}`).n).toBe(0);
    expect((await w.one`SELECT count(*)::int AS n FROM kyc_case WHERE account_id = ${b.id}`).n).toBe(1);
  });

  test('chat goes after a year, unless the errand is disputed', async () => {
    const req = await w.requester(), run = await w.runner();
    const ids: string[] = [];
    for (const status of ['settled', 'settled'] as const) {
      const e = await req.client.post('/errands', marketRun());
      await w.admin`UPDATE errand SET status = ${status}, runner_id = ${run.id} WHERE id = ${e.body.id}`;
      await w.admin`INSERT INTO message (errand_id, sender_id, body, created_at)
                    VALUES (${e.body.id}, ${req.id}, 'old', now() - interval '13 months'),
                           (${e.body.id}, ${req.id}, 'new', now())`;
      ids.push(e.body.id);
    }
    await w.admin`INSERT INTO dispute (errand_id, raised_by, reason, status) VALUES (${ids[1]}, ${req.id}, 'held for the ruling', 'evidence')`;

    await retention(w.worker.sql, w.worker.storage);

    const left = await w.admin`SELECT errand_id, body FROM message WHERE errand_id = ANY(${ids}) ORDER BY body`;
    expect(left.filter((m) => m.errand_id === ids[0]).map((m) => m.body)).toEqual(['new']);
    expect(left.filter((m) => m.errand_id === ids[1]).map((m) => m.body)).toEqual(['new', 'old']);
  });
});
