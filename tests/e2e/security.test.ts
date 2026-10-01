// The tests that make 0003_rls.sql and 09-appsec-audit.md true rather than plausible. They run
// through the real API with real accounts, over the real sidequest_app connection — never as a
// superuser, which would bypass every policy and pass regardless.
//
// Ported from the handoff's apps/api/test/security/rls.test.ts, which referenced helpers that
// did not exist; every case it named is here and runs.

import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { withActor, createDb } from '@sidequest/db';
import { World, marketRun, NAIROBI, type User } from './world.js';

const w = new World();
let alice: User, bob: User, mallory: User, aliceErrand: any;

async function funded(u: User, body = marketRun()) {
  await w.topUp(u, 300_000);
  const e = await u.client.post('/errands', body);
  await u.client.post(`/errands/${e.body.id}/publish`);
  const f = await u.client.post(`/errands/${e.body.id}/fund`, { rail: 'wallet' });
  if (f.status !== 200) throw new Error(`fund ${f.status} ${JSON.stringify(f.body)}`);
  return e.body;
}

async function assigned(requester: User, runner: User) {
  const e = await funded(requester);
  const o = await requester.client.post(`/errands/${e.id}/offer`, { runner_id: runner.id, fee_cents: 30_000 });
  if (o.status !== 201) throw new Error(`offer ${o.status} ${JSON.stringify(o.body)}`);
  const a = await runner.client.post(`/errands/${e.id}/accept`);
  if (a.status !== 200) throw new Error(`accept ${a.status} ${JSON.stringify(a.body)}`);
  await w.settle();
  return e;
}

beforeAll(async () => {
  await w.start();
  alice = await w.requester('Alice Njeri');   // owns the errand
  bob = await w.runner('Bob Otieno');          // assigned to it
  mallory = await w.runner('Mallory Kip');     // uninvolved, tier 3, fully entitled
  aliceErrand = await assigned(alice, bob);
});
afterAll(async () => { await w.stop(); });

describe('cross-tenant reads', () => {
  // Every row-bearing surface an actor could try to reach across the tenant boundary. The
  // expectation is uniform: 404 or an empty list, never a 500 and never a row.
  const cases: Array<[string, () => Promise<{ status: number; body: any }>]> = [
    ['errand',       () => mallory.client.get(`/errands/${aliceErrand.id}`)],
    ['stall',        () => mallory.client.get(`/errands/${aliceErrand.id}/stalls`)],
    ['escrow',       () => mallory.client.get(`/errands/${aliceErrand.id}/escrow`)],
    ['tranche',      () => mallory.client.get(`/errands/${aliceErrand.id}/tranches`)],
    ['evidence',     () => mallory.client.get(`/errands/${aliceErrand.id}/evidence`)],
    ['errand_offer', () => mallory.client.get(`/errands/${aliceErrand.id}/offers`)],
    ['messages',     () => mallory.client.get(`/errands/${aliceErrand.id}/messages`)],
    ['link',         () => mallory.client.get(`/errands/${aliceErrand.id}/link`)],
  ];
  for (const [name, call] of cases) {
    test(`${name} discloses nothing to an uninvolved account`, async () => {
      const res = await call();
      expect([403, 404, 200]).toContain(res.status);
      if (res.status === 200) {
        const b = res.body;
        const rows = Array.isArray(b) ? b : (b.items ?? b.data ?? b.stalls ?? b.runners ?? []);
        expect(rows).toHaveLength(0);
      }
    });
  }

  test("another account's wallet is its own, not the caller's", async () => {
    const res = await mallory.client.get(`/wallet?account_id=${alice.id}`);
    expect(res.status).toBe(200);
    expect(res.body.escrow).toHaveLength(0);
    expect(res.body.recent.every((r: any) => r.reason !== 'escrow.fund')).toBe(true);
  });

  test("a counterparty sees a display name, never a phone number", async () => {
    const d = await bob.client.get(`/errands/${aliceErrand.id}`);
    expect(d.status).toBe(200);
    expect(JSON.stringify(d.body)).not.toContain(alice.msisdn.slice(4));
    expect(d.body.requester.display_name).toBe('Alice Njeri');
  });
});

describe('cross-tenant writes', () => {
  test('a stall cannot be priced from another errand (finding #2)', async () => {
    const mine = await assigned(await w.requester('Mallory Front'), mallory);
    const s = aliceErrand.stalls[0];
    const res = await mallory.client.post(`/errands/${mine.id}/stalls/${s.id}/items`, { items: [{ id: s.items[0].id, price_cents: 1 }] });
    expect(res.status).toBe(404);
  });

  test('a stall cannot be declined from another errand', async () => {
    const other = await funded(await w.requester('Someone Else'));
    const res = await alice.client.post(`/errands/${aliceErrand.id}/stalls/${other.stalls[0].id}/decline`, { reason: 'no' });
    expect(res.status).toBe(404);
  });

  test('an offer addressed to another runner cannot be declined (finding #3)', async () => {
    const e = await funded(alice);
    await alice.client.post(`/errands/${e.id}/offer`, { runner_id: bob.id, fee_cents: 30_000 });
    const res = await mallory.client.post(`/errands/${e.id}/decline-offer`);
    expect(res.status).toBe(404);
    const after = await alice.client.get(`/errands/${e.id}`);
    expect(after.body.status).toBe('offered');
    expect(after.body.offered_to).toBe(bob.id);
  });

  test('an offered errand cannot be accepted by anyone but the invited runner', async () => {
    const e = await funded(alice);
    await alice.client.post(`/errands/${e.id}/offer`, { runner_id: bob.id, fee_cents: 30_000 });
    expect((await mallory.client.post(`/errands/${e.id}/accept`)).status).toBe(409);
    expect((await bob.client.post(`/errands/${e.id}/accept`)).status).toBe(200);
  });

  test('escrow cannot be moved by a non-requester', async () => {
    const res = await bob.client.post(`/errands/${aliceErrand.id}/stalls/${aliceErrand.stalls[0].id}/approve`);
    expect(res.status).toBe(403);
  });

  test('a user cannot raise their own verification tier', async () => {
    const r = await alice.client.patch('/me', { verification_tier: 3 });
    expect(r.status).toBe(400);
    // And at the database, under the app role, the column is not updatable at all.
    const sql = createDb(w.cfg.DATABASE_URL, { max: 1 });
    await expect(withActor(sql, { id: alice.id, role: 'requester', entitlements: [], sessionId: randomUUID() },
      (tx) => tx`UPDATE account SET verification_tier = 3 WHERE id = ${alice.id}`)).rejects.toThrow(/permission denied/);
    await sql.end();
  });

  test('a user cannot make themselves staff', async () => {
    const r = await alice.client.patch('/me', { role: 'staff' });
    expect(r.status).toBe(400);
  });

  test('a posting cannot be updated by the app role or the worker', async () => {
    for (const url of [w.cfg.DATABASE_URL, w.cfg.WORKER_DATABASE_URL!]) {
      const sql = createDb(url, { max: 1 });
      await expect(sql`UPDATE posting SET amount_cents = 0 WHERE true`).rejects.toThrow(/permission denied/);
      await expect(sql`DELETE FROM posting WHERE true`).rejects.toThrow(/permission denied/);
      await sql.end();
    }
  });

  test('the worker cannot read identity documents', async () => {
    await expect(w.worker.sql`SELECT id_number_enc FROM kyc_case LIMIT 1`).rejects.toThrow(/permission denied/);
  });
});

describe('actor context', () => {
  const app = () => createDb(w.cfg.DATABASE_URL, { max: 1 });

  test('a transaction with no actor sees nothing', async () => {
    // The failure direction that matters. If this ever returns rows, app_actor() has been
    // given a default somewhere and every policy in the file is decorative.
    const sql = app();
    const rows = await withActor(sql, null, (tx) => tx`SELECT id FROM errand LIMIT 1`);
    expect(rows).toHaveLength(0);
    await sql.end();
  });

  test('the actor GUC does not survive the transaction', async () => {
    // The PgBouncer leak, asserted: one pooled connection, two transactions.
    const sql = app();
    await withActor(sql, { id: alice.id, role: 'requester', entitlements: [], sessionId: randomUUID() }, (tx) => tx`SELECT 1`);
    const [r] = await withActor(sql, null, (tx) => tx<{ a: string | null }[]>`SELECT nullif(current_setting('app.actor_id', true), '') AS a`);
    expect(r!.a).toBeNull();
    await sql.end();
  });

  test('entitlements cannot be forged through the GUC', async () => {
    const sql = app();
    await expect(withActor(sql, { id: alice.id, role: 'requester', entitlements: ['errand.accept,legal_ops'], sessionId: randomUUID() },
      (tx) => tx`SELECT 1`)).rejects.toThrow(/Malformed entitlement/);
    await sql.end();
  });

  test('no sidequest role can bypass RLS', async () => {
    const rows = await w.admin`SELECT rolname FROM pg_roles WHERE (rolbypassrls OR rolsuper) AND rolname LIKE 'sidequest%'`;
    expect(rows).toHaveLength(0);
  });

  test('a forged or expired bearer is a 401, not an anonymous request', async () => {
    const res = await w.anon().get('/me', { headers: { authorization: 'Bearer not.a.jwt' } });
    expect(res.status).toBe(401);
  });
});

describe('location privacy', () => {
  test('nearby requires a funded, published errand of the caller', async () => {
    const draft = await alice.client.post('/errands', marketRun());
    expect((await alice.client.get(`/runners/nearby?errand_id=${draft.body.id}`)).status).toBe(409);
    expect((await (await w.requester('Nosy Parker')).client.get(`/runners/nearby?errand_id=${aliceErrand.id}`)).status).toBe(404);
  });

  test('nearby returns bands, never metres or points', async () => {
    const r = await w.runner('Nearby Runner');
    await r.client.post('/presence', { lat: NAIROBI.kangemi.lat + 0.004, lng: NAIROBI.kangemi.lng, available: true });
    const open = await funded(alice);
    const res = await alice.client.get(`/runners/nearby?errand_id=${open.id}`);
    expect(res.status).toBe(200);
    const found = res.body.runners.find((x: any) => x.runner_id === r.id);
    expect(found).toBeDefined();
    expect(found.distance_band).toBe('under_500m');
    for (const x of res.body.runners) {
      expect(x).not.toHaveProperty('metres');
      expect(x).not.toHaveProperty('lat');
      expect(x).not.toHaveProperty('lng');
    }
  });

  test('a runner 2.5 km away is still found (the H3 ring count covers the radius)', async () => {
    const far = await w.runner('Far Runner');
    await far.client.post('/presence', { lat: NAIROBI.kangemi.lat + 0.0225, lng: NAIROBI.kangemi.lng, available: true });
    const open = await funded(alice);
    const res = await alice.client.get(`/runners/nearby?errand_id=${open.id}`);
    expect(res.body.runners.find((x: any) => x.runner_id === far.id)?.distance_band).toBe('under_3km');
  });

  test('location is refused without an active link; a revoked link stops the requester reading the point', async () => {
    const fix = { errand_id: aliceErrand.id, lat: -1.2641, lng: 36.7519, accuracy_m: 10, seq: 1, hmac_tag: 'AAAA', recorded_at: new Date().toISOString() };
    expect((await bob.client.post('/location', { fixes: [fix] })).status).toBe(409);
    await bob.client.delete(`/errands/${aliceErrand.id}/link`);
    const res = await alice.client.get(`/errands/${aliceErrand.id}/location`);
    expect(res.body.point).toBeUndefined();
    expect(res.body.state).toBe('revoked');
  });
});

describe('rate limits', () => {
  test('OTP is capped per number regardless of format', async () => {
    // The canonicalisation bug: three spellings of one number must share one bucket.
    const n = `7${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const forms = [`0${n}`, `+254${n}`, `254${n}`];
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await w.anon().post('/auth/otp', { msisdn: forms[i % 3] }, { idem: false })).status);
    expect(codes.slice(0, 5).every((c) => c === 201)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  test('a 429 does not reveal which identifier tripped', async () => {
    const n = `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    let last: any;
    for (let i = 0; i < 6; i++) last = await w.anon().post('/auth/otp', { msisdn: n }, { idem: false });
    expect(last.status).toBe(429);
    expect(JSON.stringify(last.body)).not.toMatch(new RegExp(`${n.slice(2)}|msisdn|account`, 'i'));
    expect(last.headers['retry-after']).toBeDefined();
  });

  test('nearby is capped at 30 per hour', async () => {
    const u = await w.requester('Scraper Sam');
    const open = await funded(u);
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await u.client.get(`/runners/nearby?errand_id=${open.id}`)).status;
    expect(last).toBe(429);
  });
});

describe('headers, cookies and origins', () => {
  test('security headers are present on every response', async () => {
    const res = await alice.client.get('/me');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(res.headers['strict-transport-security']).toMatch(/max-age=63072000/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('the refresh cookie is httpOnly, Secure, SameSite=Strict and scoped to /auth', async () => {
    const res = await w.anon().post('/auth/refresh', { refresh: (await w.requester()).refresh }, { idem: false });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/auth/i);
  });

  test('an unlisted origin is refused; the listed one is echoed exactly', async () => {
    expect((await alice.client.get('/me', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const ok = await alice.client.get('/me', { headers: { origin: 'https://console.sidequest.test' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://console.sidequest.test');
  });

  test('a cross-site cookie write is refused', async () => {
    const res = await alice.client.post('/disputes', {}, { headers: { cookie: 'sq_refresh=x', origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  test('errors never carry a stack trace or an internal message', async () => {
    const res = await alice.client.get(`/errands/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules|postgres/i);
  });
});

describe('stored text and uploads', () => {
  test('bidi and zero-width characters do not survive a display name', async () => {
    const res = await alice.client.patch('/me', { display_name: 'A‮le​x' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Alex');
    await alice.client.patch('/me', { display_name: 'Alice Njeri' });
  });

  test('markup in a name is refused', async () => {
    expect((await alice.client.patch('/me', { display_name: '<img src=x onerror=alert(1)>' })).status).toBe(400);
  });

  test('an SVG cannot be presigned and a slot cannot traverse', async () => {
    const u = await w.signIn({ role: 'runner', name: 'New Runner' });
    const c = await u.client.post('/kyc/cases', { target_tier: 2 });
    expect(c.status).toBe(201);
    expect((await u.client.post(`/kyc/cases/${c.body.id}/documents`, { slot: 'selfie', content_type: 'image/svg+xml' })).status).toBe(400);
    expect((await u.client.post(`/kyc/cases/${c.body.id}/documents`, { slot: '../../other/selfie', content_type: 'image/jpeg' })).status).toBe(400);
  });

  test("another account's KYC case is invisible", async () => {
    const u = await w.signIn({ role: 'runner', name: 'Kyc Owner' });
    const c = await u.client.post('/kyc/cases', { target_tier: 2 });
    expect((await mallory.client.get(`/kyc/cases/${c.body.id}`)).status).toBe(404);
    expect((await mallory.client.post(`/kyc/cases/${c.body.id}/documents`, { slot: 'selfie', content_type: 'image/jpeg' })).status).toBe(404);
  });

  test('a tampered upload URL is refused', async () => {
    const u = await w.signIn({ role: 'runner', name: 'Upload Tester' });
    const c = await u.client.post('/kyc/cases', { target_tier: 2 });
    const p = await u.client.post(`/kyc/cases/${c.body.id}/documents`, { slot: 'selfie', content_type: 'image/jpeg' });
    const url = new URL(p.body.upload_url);
    const tampered = url.pathname.replace('selfie', 'id_front') + url.search;
    const r = await w.app.inject({ method: 'PUT', url: tampered, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from([1]) });
    expect(r.statusCode).toBe(403);
  });

  test('the ops CSV neutralises formula prefixes', async () => {
    const officer = await w.staff(['ops.read']);
    const res = await w.app.inject({ method: 'GET', url: '/ops/export/accounts.csv', headers: { authorization: `Bearer ${officer.access}` } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/(^|,)"?=/m);
  });
});

describe('sessions', () => {
  test('a refresh token rotates, and reusing a spent one revokes the whole family', async () => {
    const u = await w.requester('Rotating Rita');
    const first = u.refresh;
    const r1 = await w.anon().post('/auth/refresh', { refresh: first }, { idem: false });
    expect(r1.status).toBe(200);
    // The thief replays the spent token: the family dies, including the fresh token.
    expect((await w.anon().post('/auth/refresh', { refresh: first }, { idem: false })).status).toBe(401);
    expect((await w.anon().post('/auth/refresh', { refresh: r1.body.refresh }, { idem: false })).status).toBe(401);
  });

  test('a wrong OTP three times locks the challenge', async () => {
    const n = `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const otp = await w.anon().post('/auth/otp', { msisdn: n }, { idem: false });
    const code = /(\d{6})/.exec(w.sms().outbox.at(-1)!.text)![1]!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) {
      expect((await w.anon().post('/auth/verify', { challenge_id: otp.body.challenge_id, code: wrong }, { idem: false })).status).toBe(400);
    }
    const res = await w.anon().post('/auth/verify', { challenge_id: otp.body.challenge_id, code }, { idem: false });
    expect([400, 429]).toContain(res.status);
  });

  test('console sign-in (staff_only) never creates an account and admits only staff, with one answer for both', async () => {
    const attempt = async (msisdn: string) => {
      const anon = w.anon();
      const otp = await anon.post('/auth/otp', { msisdn }, { idem: false });
      const code = /(\d{6})/.exec(w.sms().outbox.at(-1)!.text)![1]!;
      return anon.post('/auth/verify', { challenge_id: otp.body.challenge_id, code, staff_only: true }, { idem: false });
    };
    const stranger = `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const none = await attempt(stranger);
    const [created] = await w.admin`SELECT count(*)::int AS n FROM account WHERE msisdn = ${`+254${stranger.slice(1)}`}`;
    expect(created.n).toBe(0);

    const customer = await w.requester('Curious Carol');
    const notStaff = await attempt(`0${customer.msisdn.slice(4)}`);
    expect([none.status, notStaff.status]).toEqual([403, 403]);
    expect(none.body.code).toBe('NOT_STAFF');
    expect(notStaff.body).toMatchObject({ code: none.body.code, title: none.body.title });
    expect(notStaff.body.access).toBeUndefined();

    const officer = await w.staff(['ops.read']);
    const ok = await attempt(`0${officer.msisdn.slice(4)}`);
    expect(ok.status).toBe(200);
    expect(ok.body.account.role).toBe('staff');
  });

  test('a revoked session stops money moving immediately, not in 15 minutes', async () => {
    const u = await w.requester('Logout Lucy');
    await w.topUp(u, 10_000);
    await u.client.post('/auth/logout');
    const res = await u.client.post('/wallet/topup', { amount_cents: 10_000 });
    expect(res.status).toBe(401);
  });
});

describe('idempotency', () => {
  test('a replayed key returns the stored response and does not act twice', async () => {
    const u = await w.requester('Idem Ivy');
    const key = randomUUID();
    const a = await u.client.post('/wallet/topup', { amount_cents: 10_000 }, { idem: key });
    const b = await u.client.post('/wallet/topup', { amount_cents: 10_000 }, { idem: key });
    expect(b.status).toBe(a.status);
    expect(b.body.payment_id).toBe(a.body.payment_id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    await w.settle();
    expect((await u.client.get('/wallet')).body.balance_cents).toBe(10_000);
  });

  test('a key reused with a different body is a conflict, not the wrong replay', async () => {
    const u = await w.requester('Idem Ian');
    const key = randomUUID();
    await u.client.post('/wallet/topup', { amount_cents: 10_000 }, { idem: key });
    const b = await u.client.post('/wallet/topup', { amount_cents: 20_000 }, { idem: key });
    expect(b.status).toBe(409);
    expect(b.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('money routes refuse to run without a key', async () => {
    const u = await w.requester('No Key');
    expect((await u.client.post('/wallet/topup', { amount_cents: 10_000 }, { idem: false })).status).toBe(400);
  });
});

// Webhook source, token and forgery tests live in audit.test.ts (findings 2 and 6).

void postgres;
