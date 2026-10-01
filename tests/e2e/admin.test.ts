// The ops console's admin surface: overview, people, suspension, staff access, SOS, errands and
// finance — through the API, and the database guards (0008_admin.sql) underneath it, tested
// directly as sidequest_ops so a gateway bug could not hide a policy hole.

import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withActor, createDb } from '@sidequest/db';
import { World, marketRun, type User } from './world.js';

let w: World;
beforeAll(async () => { w = await new World().start(); });
afterAll(async () => { await w.stop(); });

const local = (u: User) => `0${u.msisdn.slice(4)}`;

async function liveErrand(req: User, run: User) {
  await w.topUp(req, 400_000);
  const e = (await req.client.post('/errands', marketRun())).body;
  await req.client.post(`/errands/${e.id}/publish`);
  await req.client.post(`/errands/${e.id}/fund`, { rail: 'wallet' });
  await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 30_000 });
  await run.client.post(`/errands/${e.id}/accept`);
  await w.settle();
  return e;
}

/** Run SQL as the ops role with the given entitlements — what the API would do, minus the API. */
async function asOps<T>(actorId: string, ents: string[], fn: Parameters<typeof withActor<T>>[2]) {
  const sql = createDb(w.cfg.OPS_DATABASE_URL, { max: 1 });
  try { return await withActor(sql, { id: actorId, role: 'staff', entitlements: ents, sessionId: randomUUID() }, fn); }
  finally { await sql.end({ timeout: 2 }); }
}

describe('overview', () => {
  test('counts for ops.read; KYC and money only with their own entitlements, never a false zero', async () => {
    const reader = await w.staff(['ops.read']);
    const o = (await reader.client.get('/ops/overview')).body;
    expect(o.counts).toMatchObject({ disputes_open: expect.any(Number), sos_open: expect.any(Number), errands_live: expect.any(Number) });
    expect(o.counts.kyc_waiting).toBeNull();
    expect(o.money).toBeNull();
    expect(o.series).toHaveLength(14);

    const finance = await w.staff(['ops.read', 'ledger.read', 'kyc.review']);
    const f = (await finance.client.get('/ops/overview')).body;
    expect(f.counts.kyc_waiting).toEqual(expect.any(Number));
    expect(f.money).toMatchObject({ revenue_7d_cents: expect.any(Number), escrow_held_cents: expect.any(Number) });
  });

  test('customers cannot reach any of it', async () => {
    const u = await w.requester('Nosy Nora');
    for (const path of ['/ops/overview', '/ops/accounts', '/ops/sos', '/ops/errands', '/ops/finance']) {
      expect((await u.client.get(path)).status).toBe(403);
    }
  });
});

describe('people', () => {
  test('search by name or full number; numbers are masked; a partial number is refused', async () => {
    const u = await w.requester('Searchable Sifa');
    const reader = await w.staff(['ops.read']);
    const byName = (await reader.client.get('/ops/accounts?q=Searchable%20Sif')).body.data;
    expect(byName.map((a: any) => a.id)).toContain(u.id);
    const hit = byName.find((a: any) => a.id === u.id);
    expect(hit.msisdn_masked).toBe(`…${u.msisdn.slice(-3)}`);
    expect(JSON.stringify(byName)).not.toContain(u.msisdn.slice(4));
    expect((await reader.client.get(`/ops/accounts?q=${encodeURIComponent(local(u))}`)).body.data.map((a: any) => a.id)).toEqual([u.id]);
    expect((await reader.client.get('/ops/accounts?q=071234')).status).toBe(400);
    // A LIKE wildcard is matched literally, so "%" is not a way to list everyone.
    expect((await reader.client.get('/ops/accounts?q=%25%25%25')).body.data).toEqual([]);
  });

  test('a profile is audited; its audit trail needs audit.read', async () => {
    const u = await w.requester('Profiled Pam');
    const reader = await w.staff(['ops.read']);
    const p = (await reader.client.get(`/ops/accounts/${u.id}`)).body;
    expect(p).toMatchObject({ id: u.id, display_name: 'Profiled Pam', stats: { posted: 0 }, audit: null });
    const [row] = await w.admin`SELECT count(*)::int AS n FROM audit_log WHERE action = 'account.view' AND subject = ${u.id}`;
    expect(row!.n).toBe(1);
    const auditor = await w.staff(['ops.read', 'audit.read']);
    const trail = (await auditor.client.get(`/ops/accounts/${u.id}`)).body.audit;
    expect(trail.map((t: any) => t.action)).toContain('account.view');
  });
});

describe('suspension', () => {
  test('needs accounts.manage; signs the person out everywhere at once; reinstating restores access', async () => {
    const u = await w.requester('Suspended Sam');
    const reader = await w.staff(['ops.read']);
    expect((await reader.client.post(`/ops/accounts/${u.id}/suspend`, { reason: 'Repeated chargebacks' })).status).toBe(403);

    const manager = await w.staff(['ops.read', 'accounts.manage', 'audit.read']);
    const s = await manager.client.post(`/ops/accounts/${u.id}/suspend`, { reason: 'Repeated chargebacks' });
    expect(s.status).toBe(200);
    expect(s.body.sessions_revoked).toBeGreaterThan(0);
    // The still-unexpired access token no longer moves money, and refresh is refused.
    expect((await u.client.post('/wallet/topup', { amount_cents: 10_000 })).status).toBe(401);
    expect((await w.anon().post('/auth/refresh', { refresh: u.refresh }, { idem: false })).status).toBe(401);
    expect((await manager.client.post(`/ops/accounts/${u.id}/suspend`, { reason: 'Repeated chargebacks' })).status).toBe(409);
    const [n] = await w.admin`SELECT count(*)::int AS n FROM outbox_event WHERE queue = 'notify' AND payload->>'accountId' = ${u.id} AND payload->>'template' = 'account.suspended'`;
    expect(n!.n).toBe(1);

    expect((await manager.client.post(`/ops/accounts/${u.id}/reinstate`, { reason: 'Chargebacks were the bank' })).status).toBe(200);
    const back = await w.signIn({ msisdn: local(u) });
    expect(back.id).toBe(u.id);
    const trail = (await manager.client.get(`/ops/accounts/${u.id}`)).body.audit.map((t: any) => t.action);
    expect(trail).toEqual(expect.arrayContaining(['account.suspend', 'account.reinstate']));
  });

  test('nobody suspends themselves', async () => {
    const manager = await w.staff(['ops.read', 'accounts.manage']);
    expect((await manager.client.post(`/ops/accounts/${manager.id}/suspend`, { reason: 'Testing the guard' })).status).toBe(403);
  });

  test('database guard: a KYC reviewer can raise a tier but cannot suspend (the old policy allowed it)', async () => {
    const u = await w.requester('Guarded Gita');
    const reviewer = await w.staff(['kyc.review']);
    await expect(asOps(reviewer.id, ['kyc.review'], (tx) => tx`UPDATE account SET suspended_at = now() WHERE id = ${u.id}`))
      .rejects.toMatchObject({ code: '42501' });
    // kyc.review alone (no ops.read) must still reach the row it approves.
    const moved = await asOps(reviewer.id, ['kyc.review'], (tx) => tx`UPDATE account SET verification_tier = 2 WHERE id = ${u.id} RETURNING id`);
    expect(moved).toHaveLength(1);
    const [a] = await w.admin`SELECT verification_tier, suspended_at FROM account WHERE id = ${u.id}`;
    expect(a).toMatchObject({ verification_tier: 2, suspended_at: null });
  });
});

describe('staff access', () => {
  test('staff.admin sets another officer\'s grants; never their own; only known grants', async () => {
    const admin = await w.staff(['ops.read', 'staff.admin']);
    const officer = await w.staff(['ops.read']);
    const r = await admin.client.put(`/ops/accounts/${officer.id}/grants`, { grants: ['ops.read', 'evidence.view'] });
    expect(r.body.grants).toEqual(['evidence.view', 'ops.read']);
    const after = await w.refresh(officer);
    expect((await after.client.get('/me')).body.entitlements).toContain('evidence.view');

    expect((await admin.client.put(`/ops/accounts/${admin.id}/grants`, { grants: ['ops.read', 'legal_ops'] })).status).toBe(403);
    expect((await admin.client.put(`/ops/accounts/${officer.id}/grants`, { grants: ['god.mode'] })).status).toBe(400);
    const plain = await w.staff(['ops.read']);
    expect((await plain.client.put(`/ops/accounts/${officer.id}/grants`, { grants: [] })).status).toBe(403);
  });

  test('promotion to staff: refused mid-errand, one-way, and the token carries the new role', async () => {
    const admin = await w.staff(['ops.read', 'staff.admin']);
    const busy = await w.requester('Busy Bea');
    const run = await w.runner('Busy Runner');
    await liveErrand(busy, run);
    expect((await admin.client.post(`/ops/accounts/${busy.id}/make-staff`, { grants: ['ops.read'] })).status).toBe(409);

    const hire = await w.requester('New Hire Hana');
    const p = await admin.client.post(`/ops/accounts/${hire.id}/make-staff`, { grants: ['ops.read', 'kyc.review'] });
    expect(p.status).toBe(200);
    const me = (await (await w.refresh(hire)).client.get('/me')).body;
    expect(me.role).toBe('staff');
    expect(me.entitlements).toEqual(expect.arrayContaining(['ops.read', 'kyc.review']));
    // One-way, enforced by the database even for a staff.admin.
    await expect(asOps(admin.id, ['staff.admin'], (tx) => tx`UPDATE account SET role = 'requester', staff_grants = '{}' WHERE id = ${hire.id}`))
      .rejects.toMatchObject({ code: '42501' });
  });
});

describe('SOS queue', () => {
  test('an SOS appears, is acknowledged, resolved with a note, and leaves the open queue', async () => {
    const req = await w.requester('Scared Sue');
    const run = await w.runner('SOS Runner');
    const e = await liveErrand(req, run);
    const sos = await req.client.post(`/errands/${e.id}/sos`, { lat: -1.29, lng: 36.78 });
    expect(sos.status).toBe(201);

    const ops = await w.staff(['ops.read']);
    const open = (await ops.client.get('/ops/sos')).body.data.find((s: any) => s.id === sos.body.sos_id);
    expect(open).toMatchObject({ raised_by_role: 'requester', raised_by_name: 'Scared Sue', acknowledged_at: null });
    expect((await ops.client.post(`/ops/sos/${sos.body.sos_id}/acknowledge`, {})).status).toBe(200);
    expect((await ops.client.post(`/ops/sos/${sos.body.sos_id}/acknowledge`, {})).status).toBe(409);
    expect((await ops.client.post(`/ops/sos/${sos.body.sos_id}/resolve`, { note: 'no' })).status).toBe(400);
    expect((await ops.client.post(`/ops/sos/${sos.body.sos_id}/resolve`, { note: 'Called both parties; runner was lost, all safe.' })).status).toBe(200);
    expect((await ops.client.get('/ops/sos')).body.data.map((s: any) => s.id)).not.toContain(sos.body.sos_id);
    const done = (await ops.client.get('/ops/sos?status=resolved')).body.data.find((s: any) => s.id === sos.body.sos_id);
    expect(done.resolution_note).toContain('all safe');
  });

  test('database guard: ops can record handling, but not rewrite what was reported', async () => {
    const req = await w.requester('Report Rita');
    const run = await w.runner('Report Runner');
    const e = await liveErrand(req, run);
    const sos = (await req.client.post(`/errands/${e.id}/sos`, { lat: -1.29, lng: 36.78 })).body;
    const ops = await w.staff(['ops.read']);
    await expect(asOps(ops.id, ['ops.read'], (tx) => tx`UPDATE sos_case SET lat = 0, snapshot = '{}' WHERE id = ${sos.sos_id}`))
      .rejects.toMatchObject({ code: '42501' });
  });
});

describe('errands and finance', () => {
  test('the errands list filters live work and finds by title', async () => {
    const req = await w.requester('Listed Lucy');
    const run = await w.runner('Listed Runner');
    const e = await liveErrand(req, run);
    const ops = await w.staff(['ops.read']);
    const live = (await ops.client.get('/ops/errands?status=live')).body.data;
    expect(live.find((x: any) => x.id === e.id)).toMatchObject({ requester_name: 'Listed Lucy', runner_name: 'Listed Runner' });
    expect((await ops.client.get(`/ops/errands?status=all&q=${e.id}`)).body.data.map((x: any) => x.id)).toEqual([e.id]);
  });

  test('finance needs ledger.read, is audited, and the ledger balances to zero', async () => {
    const reader = await w.staff(['ops.read']);
    expect((await reader.client.get('/ops/finance')).status).toBe(403);
    const fin = await w.staff(['ops.read', 'ledger.read']);
    const f = (await fin.client.get('/ops/finance')).body;
    expect(f.balances.length).toBeGreaterThan(0);
    // Double entry: every posting group sums to zero, so the whole ledger does too.
    expect(f.balances.reduce((a: number, b: any) => a + b.balance_cents, 0)).toBe(0);
    const [row] = await w.admin`SELECT count(*)::int AS n FROM audit_log WHERE action = 'finance.view' AND actor_id = ${fin.id}`;
    expect(row!.n).toBe(1);
  });
});
