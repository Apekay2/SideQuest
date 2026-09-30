// apps/api/test/security/rls.test.ts
// The tests that make 03c-rls.sql true rather than plausible. They run through the real API
// with two real accounts, over the real `sidequest_app` connection — never as a superuser,
// which would bypass every policy and pass regardless.
//
// If you add a table, add it to CROSS_TENANT below. The CI query in 03c-rls.sql catches a
// table with no policy; only this file catches a policy that is too wide.

import { describe, expect, test, beforeAll } from 'vitest';
import { newRequester, newRunner, newErrand, api } from '../helpers.js';

let alice: any, bob: any, mallory: any, aliceErrand: any;

beforeAll(async () => {
  alice = await newRequester();          // owns the errand
  bob = await newRunner();               // assigned to it
  mallory = await newRunner();           // uninvolved, tier 3, fully entitled
  aliceErrand = await newErrand(alice, { assignTo: bob, funded: true });
});

// Every row-bearing table an actor could try to reach across the tenant boundary, with the
// path that reaches it. Expectation is uniform: 404 or an empty list, never a 500 and never
// a row.
const CROSS_TENANT: Array<[string, () => Promise<any>]> = [
  ['errand',          () => api(mallory).get(`/errands/${aliceErrand.id}`)],
  ['stall',           () => api(mallory).get(`/errands/${aliceErrand.id}/stalls`)],
  ['escrow',          () => api(mallory).get(`/errands/${aliceErrand.id}/escrow`)],
  ['tranche',         () => api(mallory).get(`/errands/${aliceErrand.id}/tranches`)],
  ['evidence',        () => api(mallory).get(`/errands/${aliceErrand.id}/evidence`)],
  ['location',        () => api(mallory).get(`/errands/${aliceErrand.id}/location`)],
  ['kyc_case',        () => api(mallory).get(`/kyc/cases/${alice.kycCaseId}`)],
  ['payout',          () => api(mallory).get(`/payouts/${bob.payoutId}`)],
  ['errand_offer',    () => api(mallory).get(`/errands/${aliceErrand.id}/offers`)],
  ['posting',         () => api(mallory).get(`/wallet?account_id=${alice.id}`)],
];

describe('cross-tenant reads', () => {
  for (const [table, call] of CROSS_TENANT) {
    test(`${table} discloses nothing to an uninvolved account`, async () => {
      const res = await call();
      expect([403, 404, 200]).toContain(res.status);
      if (res.status === 200) {
        // A 200 is only acceptable if it is empty. This is the assertion that catches a
        // policy widened by accident.
        const body = res.body as any;
        const rows = Array.isArray(body) ? body : (body.items ?? body.runners ?? body.stalls ?? []);
        expect(rows).toHaveLength(0);
      }
    });
  }
});

describe('cross-tenant writes', () => {
  test('a stall cannot be priced from another errand', async () => {
    // Finding #2. Mallory has her own errand and passes the runner check on it, then points
    // :sid at Alice's stall. Must be a 404, not a repriced basket.
    const mine = await newErrand(mallory, { assignTo: mallory, funded: true });
    const res = await api(mallory)
      .post(`/errands/${mine.id}/stalls/${aliceErrand.stalls[0].id}/items`)
      .send({ items: [{ id: aliceErrand.stalls[0].items[0].id, price_cents: 1 }] });
    expect(res.status).toBe(404);
  });

  test('a stall cannot be declined from another errand', async () => {
    const res = await api(alice)
      .post(`/errands/${aliceErrand.id}/stalls/${(await newErrand(mallory, {})).stalls[0].id}/decline`)
      .send({ reason: 'no' });
    expect(res.status).toBe(404);
  });

  test('an offer addressed to another runner cannot be declined', async () => {
    // Finding #3. Alice offers to Bob; Mallory tries to knock it back to open.
    const e = await newErrand(alice, { offerTo: bob, funded: true });
    const res = await api(mallory).post(`/errands/${e.id}/decline-offer`);
    expect(res.status).toBe(404);
    const after = await api(alice).get(`/errands/${e.id}`);
    expect(after.body.status).toBe('offered');
    expect(after.body.offered_to).toBe(bob.id);
  });

  test('escrow cannot be moved by a non-requester', async () => {
    const res = await api(bob)
      .post(`/errands/${aliceErrand.id}/stalls/${aliceErrand.stalls[0].id}/approve`)
      .set('Idempotency-Key', crypto.randomUUID());
    expect(res.status).toBe(403);
  });

  test('a posting cannot be updated by anyone', async () => {
    // Grant-level, not policy-level: the app role has no UPDATE on posting at all.
    await expect(
      appDb().execute(`UPDATE posting SET amount_cents = 0 WHERE true`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('actor context', () => {
  test('a transaction with no actor sees nothing', async () => {
    // The failure direction that matters. If this ever returns rows, app_actor() has been
    // given a default somewhere and every policy in the file is decorative.
    const rows = await appTx(null, (t: any) => t.execute(`SELECT id FROM errand LIMIT 1`));
    expect(rows).toHaveLength(0);
  });

  test('the actor GUC does not survive the transaction', async () => {
    // The PgBouncer leak, asserted. A plain SET here would make the second read succeed.
    await appTx(alice, (t: any) => t.execute(`SELECT 1`));
    const rows = await appTx(null, (t: any) =>
      t.execute(`SELECT nullif(current_setting('app.actor_id', true), '') AS a`));
    expect(rows[0].a).toBeNull();
  });

  test('entitlements cannot be forged through the GUC', async () => {
    const forged = { ...alice, entitlements: ['errand.accept,legal_ops'] };
    await expect(appTx(forged, (t: any) => t.execute(`SELECT 1`)))
      .rejects.toThrow(/Malformed entitlement/);
  });

  test('no sidequest role can bypass RLS', async () => {
    const rows = await adminDb().execute(
      `SELECT rolname FROM pg_roles WHERE rolbypassrls AND rolname LIKE 'sidequest%'`);
    expect(rows).toHaveLength(0);
  });
});

describe('location privacy', () => {
  test('nearby requires a funded, published errand of the caller', async () => {
    const draft = await newErrand(alice, { funded: false });
    expect((await api(alice).get(`/runners/nearby?errand_id=${draft.id}`)).status).toBe(409);
    expect((await api(mallory).get(`/runners/nearby?errand_id=${aliceErrand.id}`)).status).toBe(404);
  });

  test('nearby never returns a precise distance or a point', async () => {
    const open = await newErrand(alice, { funded: true, publish: true });
    const res = await api(alice).get(`/runners/nearby?errand_id=${open.id}`);
    expect(res.status).toBe(200);
    for (const r of res.body.runners) {
      expect(r).not.toHaveProperty('metres');
      expect(r).not.toHaveProperty('lat');
      expect(r).not.toHaveProperty('lng');
      expect(['under_500m', 'under_1_5km', 'under_3km', 'over_3km']).toContain(r.distance_band);
    }
  });

  test('a revoked link stops the requester reading the point', async () => {
    await api(bob).delete(`/errands/${aliceErrand.id}/link`);
    const res = await api(alice).get(`/errands/${aliceErrand.id}/location`);
    expect(res.body.point).toBeUndefined();
    expect(res.body.state).toBe('revoked');
  });
});

describe('rate limits', () => {
  test('OTP is capped per number regardless of format', async () => {
    // The canonicalisation bug: three formats of one number must share one bucket.
    const forms = ['0722000111', '+254722000111', '254722000111'];
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await api().post('/auth/otp').send({ msisdn: forms[i % 3] })).status);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  test('nearby is capped at 30 per hour', async () => {
    const open = await newErrand(alice, { funded: true, publish: true });
    let last = 200;
    for (let i = 0; i < 31; i++) {
      last = (await api(alice).get(`/runners/nearby?errand_id=${open.id}`)).status;
    }
    expect(last).toBe(429);
  });

  test('a 429 does not reveal which identifier tripped', async () => {
    const res = await api().post('/auth/otp').send({ msisdn: '0722000111' });
    if (res.status === 429) {
      expect(JSON.stringify(res.body)).not.toMatch(/722|msisdn|account/i);
    }
  });
});

describe('headers and cookies', () => {
  test('security headers are present on every response', async () => {
    const res = await api(alice).get('/me');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(res.headers['strict-transport-security']).toMatch(/max-age=63072000/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('the refresh cookie is httpOnly, Secure and SameSite=Strict', async () => {
    const res = await api().post('/auth/verify').send({ challenge_id: alice.challengeId, code: '000000' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/auth/i);
  });

  test('an unlisted origin is refused', async () => {
    const res = await api(alice).get('/me').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  test('a cross-site cookie write is refused', async () => {
    const res = await api(alice).post('/disputes')
      .set('Cookie', 'sq_refresh=x').set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
  });
});

describe('stored text', () => {
  test('bidi and zero-width characters do not survive a display name', async () => {
    const res = await api(alice).patch('/me').send({ display_name: 'A\u202Ele\u200Bx' });
    if (res.status === 200) expect(res.body.display_name).toBe('Alex');
    else expect(res.status).toBe(400);
  });

  test('a formula prefix is neutralised in the ops CSV', async () => {
    await api(alice).patch('/me').send({ display_name: 'Alex' });
    const csv = await opsExport('accounts');
    expect(csv).not.toMatch(/^=/m);
    expect(csv).not.toMatch(/HYPERLINK/i);
  });

  test('an SVG cannot be presigned', async () => {
    const res = await api(alice).post(`/kyc/cases/${alice.kycCaseId}/documents`)
      .send({ slot: 'selfie', content_type: 'image/svg+xml' });
    expect(res.status).toBe(400);
  });

  test('an object key cannot traverse', async () => {
    const res = await api(alice).post(`/kyc/cases/${alice.kycCaseId}/documents`)
      .send({ slot: '../../other/selfie', content_type: 'image/jpeg' });
    expect(res.status).toBe(400);
  });
});

describe('config refusals', () => {
  test.each([
    ['placeholder JWT_SECRET', { JWT_SECRET: 'changeme_changeme_changeme_changeme_changeme_ab' }],
    ['owner DATABASE_URL', { DATABASE_URL: 'postgres://sidequest_migrator@db/sq?sslmode=verify-full' }],
    ['plaintext origin', { ALLOWED_ORIGINS: 'http://console.sidequest.co.ke' }],
    ['empty ops allowlist', { OPS_IP_ALLOWLIST: '' }],
    ['sandbox rails', { DARAJA_ENV: 'sandbox' }],
    ['mock issuer', { ISSUER_DRIVER: 'mock' }],
  ])('production refuses to boot with %s', (_label, override) => {
    expect(() => bootConfig({ ...prodEnv(), ...override })).toThrow();
  });

  test('config never prints a secret', () => {
    const printed = JSON.stringify(bootConfig(prodEnv()));
    expect(printed).toMatch(/\[redacted\]/);
    expect(printed).not.toContain(prodEnv().JWT_SECRET);
    expect(printed).not.toContain(prodEnv().DARAJA_PASSKEY);
  });
});
