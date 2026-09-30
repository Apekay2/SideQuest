// Concurrency and the flows off the market-run happy path: the first-accept race, the cap
// race under SERIALIZABLE, an upfront errand with its unspent balance returned, cancellation
// fees, pick-mode offers lapsing, a dispute ruled by Legal Operations, KYC review, the link
// handshake with authenticated location, and chat.

import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateDeviceKeys, rawPublicKey, deriveSecret, linkHash, tagFix, verifyFix } from '@sidequest/domain/errand/link-handshake';
import type { MockIssuer } from '@sidequest/adapters';
import { reconcile } from '@sidequest/worker/jobs/reconcile.job';
import { World, marketRun, NAIROBI, type User } from './world.js';

const w = new World();
beforeAll(async () => { await w.start(); });
afterAll(async () => { await w.stop(); });

async function openErrand(u: User, over: Record<string, unknown> = {}) {
  await w.topUp(u, 400_000);
  const e = await u.client.post('/errands', marketRun(over));
  if (e.status !== 201) throw new Error(`create ${e.status} ${JSON.stringify(e.body)}`);
  await u.client.post(`/errands/${e.body.id}/publish`);
  const f = await u.client.post(`/errands/${e.body.id}/fund`, { rail: 'wallet' });
  if (f.status !== 200) throw new Error(`fund ${f.status} ${JSON.stringify(f.body)}`);
  return e.body;
}

async function photograph(runner: User, errandId: string, stall: any, prices: number[]) {
  await runner.client.post(`/errands/${errandId}/stalls/${stall.id}/items`, {
    items: stall.items.map((it: any, i: number) => ({ id: it.id, price_cents: prices[i] ?? prices[0] })),
  });
  const ev = await runner.client.post(`/errands/${errandId}/stalls/${stall.id}/evidence`, {
    kind: 'goods', content_type: 'image/jpeg', taken_at: new Date().toISOString(),
  });
  const url = new URL(ev.body.upload_url);
  await w.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from([0xff, 0xd8]) });
  const s = await runner.client.post(`/errands/${errandId}/stalls/${stall.id}/submit`);
  if (s.status !== 204) throw new Error(`submit ${s.status} ${JSON.stringify(s.body)}`);
}

describe('concurrency', () => {
  test('first write wins: of eight runners racing for an open errand, exactly one gets it', async () => {
    const req = await w.requester('Race Organiser');
    const e = await openErrand(req, { assignment_mode: 'open' });
    const runners = await Promise.all(Array.from({ length: 8 }, (_, i) => w.runner(`Racer ${String.fromCharCode(65 + i)}`)));
    const results = await Promise.all(runners.map((r) => r.client.post(`/errands/${e.id}/accept`)));
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(7);
    const losers = results.filter((r) => r.status === 409);
    expect(losers.every((r) => r.body.code === 'ALREADY_ASSIGNED')).toBe(true);
    const [row] = await w.admin`SELECT count(*)::int AS n FROM errand_fee WHERE errand_id = ${e.id}`;
    expect(row.n).toBe(1);
  });

  test('two approvals racing for the last of the cap: one loads, the other is refused', async () => {
    const req = await w.requester('Cap Racer');
    const run = await w.runner('Cap Runner');
    // Cap KSh 500; two stalls at KSh 300 each. Either fits alone; both do not.
    const e = await openErrand(req, { spend_cap_cents: 50_000 });
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 20_000 });
    await run.client.post(`/errands/${e.id}/accept`);
    await w.settle();
    await run.client.post(`/errands/${e.id}/start`);
    await run.client.post(`/errands/${e.id}/arrive`);
    await photograph(run, e.id, e.stalls[0], [10_000, 10_000, 10_000]);
    await photograph(run, e.id, e.stalls[1], [30_000]);

    const [a, b] = await Promise.all([
      req.client.post(`/errands/${e.id}/stalls/${e.stalls[0].id}/approve`),
      req.client.post(`/errands/${e.id}/stalls/${e.stalls[1].id}/approve`),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);
    const refused = [a, b].find((r) => r.status === 409)!;
    expect(['SPEND_CAP_EXCEEDED', 'CONCURRENT_UPDATE']).toContain(refused.body.code);
    const [sum] = await w.admin`SELECT spent_cents FROM errand WHERE id = ${e.id}`;
    expect(Number(sum.spent_cents)).toBe(30_000);
  });

  test('over the cap, approval is refused with the shortfall, never silently', async () => {
    const req = await w.requester('Over Cap');
    const run = await w.runner('Over Runner');
    const e = await openErrand(req, { spend_cap_cents: 20_000 });
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 20_000 });
    await run.client.post(`/errands/${e.id}/accept`);
    await w.settle();
    await run.client.post(`/errands/${e.id}/start`);
    await run.client.post(`/errands/${e.id}/arrive`);
    await photograph(run, e.id, e.stalls[0], [10_000, 10_000, 10_000]);
    const r = await req.client.post(`/errands/${e.id}/stalls/${e.stalls[0].id}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SPEND_CAP_EXCEEDED');
    expect(r.body.details).toMatchObject({ requested_cents: 30_000, remaining_cents: 20_000, over_by_cents: 10_000 });
  });
});

describe('upfront errand: queue standing', () => {
  test('the whole cap loads at assignment and what is left comes back at settlement', async () => {
    const req = await w.requester('Queue Quinn');
    const run = await w.runner('Queue Runner');
    const e = await openErrand(req, {
      kind: 'queue_stand', title: 'Stand in line at Huduma Centre', stalls: [],
      spend_cap_cents: 50_000, bonus_cents: 0, pickup: { ...NAIROBI.westlands, label: 'Huduma Centre GPO' },
    });
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 25_000 });
    await run.client.post(`/errands/${e.id}/accept`);
    await w.settle();

    const t = await run.client.get(`/errands/${e.id}/tranches`);
    expect(t.body.items[0]).toMatchObject({ seq: 0, amount_cents: 50_000, status: 'loaded' });

    // The runner pays a KSh 200 service fee at the counter with the card.
    const [c] = await w.admin`SELECT issuer_ref FROM card WHERE errand_id = ${e.id}`;
    await (w.worker.issuer as MockIssuer).simulateSpend(c.issuer_ref, 20_000);

    await run.client.post(`/errands/${e.id}/start`);
    await run.client.post(`/errands/${e.id}/arrive`);
    expect((await run.client.post(`/errands/${e.id}/ready`)).body.status).toBe('handover');
    const tok = await req.client.get(`/errands/${e.id}/handover-token`);
    await run.client.post(`/errands/${e.id}/handover`, { qr_token: tok.body.qr_token });
    await w.settle();

    const d = await req.client.get(`/errands/${e.id}`);
    expect(d.body.card.voided).toBe(true);
    expect(d.body.escrow.held_cents).toBe(0);
    // KSh 300 of the KSh 500 cap was never spent; it is back in the wallet.
    const wallet = await req.client.get('/wallet');
    const refund = wallet.body.recent.find((r: any) => r.reason === 'errand.settle');
    expect(refund).toBeDefined();
  });
});

describe('cancellation', () => {
  test('before assignment the whole deposit comes back', async () => {
    const req = await w.requester('Cancel Early');
    const before = (await (async () => { await w.topUp(req, 400_000); return req.client.get('/wallet'); })()).body.balance_cents;
    const e = await req.client.post('/errands', marketRun());
    await req.client.post(`/errands/${e.body.id}/publish`);
    await req.client.post(`/errands/${e.body.id}/fund`, { rail: 'wallet' });
    const c = await req.client.post(`/errands/${e.body.id}/cancel`, {});
    expect(c.body.status).toBe('cancelled');
    expect((await req.client.get('/wallet')).body.balance_cents).toBe(before);
  });

  test('after assignment the runner keeps the lesser of the fee and KSh 150', async () => {
    const req = await w.requester('Cancel Late');
    const run = await w.runner('Cancelled Runner');
    const e = await openErrand(req);
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 30_000 });
    await run.client.post(`/errands/${e.id}/accept`);
    await w.settle();
    const c = await req.client.post(`/errands/${e.id}/cancel`, {});
    expect(c.body).toMatchObject({ status: 'cancelled', runner_fee_cents: 15_000 });
    await w.settle();
    expect((await run.client.get('/earnings')).body.available_cents).toBe(15_000);
    expect((await req.client.get(`/errands/${e.id}`)).body.card.voided).toBe(true);
  });

  test('once shopping has started, cancel is refused — that is a dispute', async () => {
    const req = await w.requester('Too Late');
    const run = await w.runner('Shopping Runner');
    const e = await openErrand(req);
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 30_000 });
    await run.client.post(`/errands/${e.id}/accept`);
    await w.settle();
    await run.client.post(`/errands/${e.id}/start`);
    await run.client.post(`/errands/${e.id}/arrive`);
    const c = await req.client.post(`/errands/${e.id}/cancel`, {});
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('ERRAND_STATE_INVALID');
  });
});

describe('pick mode', () => {
  test('a declined offer returns the errand to open; a lapsed one does too', async () => {
    const req = await w.requester('Picky Pat');
    const r1 = await w.runner('Decliner');
    const r2 = await w.runner('Sleeper');
    const e = await openErrand(req);
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: r1.id, fee_cents: 30_000 });
    expect((await r1.client.post(`/errands/${e.id}/decline-offer`)).status).toBe(204);
    expect((await req.client.get(`/errands/${e.id}`)).body.status).toBe('open');

    const o = await req.client.post(`/errands/${e.id}/offer`, { runner_id: r2.id, fee_cents: 30_000 });
    await w.admin`UPDATE errand_offer SET expires_at = now() - interval '1 second' WHERE id = ${o.body.offer_id}`;
    await w.admin`UPDATE errand SET offer_expires_at = now() - interval '1 second' WHERE id = ${e.id}`;
    expect((await r2.client.post(`/errands/${e.id}/accept`)).status).toBe(409);
    await w.settle({ ignoreDelay: true, only: ['offer.expire'] });
    expect((await req.client.get(`/errands/${e.id}`)).body.status).toBe('open');
  });

  test('a tier-2 runner can bid but cannot be offered a card-carrying errand', async () => {
    const req = await w.requester('Tier Tess');
    const t2 = await w.runner('Tier Two', 2);
    const e = await openErrand(req);
    expect((await t2.client.post(`/errands/${e.id}/bids`, { fee_cents: 30_000, eta_minutes: 30 })).status).toBe(201);
    const o = await req.client.post(`/errands/${e.id}/offer`, { runner_id: t2.id, fee_cents: 30_000 });
    expect(o.status).toBe(409);
    expect(o.body.code).toBe('TIER_REQUIRED');
    expect((await t2.client.post(`/errands/${e.id}/accept`)).body.code).toBe('TIER_REQUIRED');
  });
});

describe('disputes and Legal Operations', () => {
  test('a report freezes escrow and voids the card; only legal_ops can split it', async () => {
    const req = await w.requester('Disputing Dora');
    const run = await w.runner('Disputed Dan');
    const e = await openErrand(req);
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 30_000 });
    await run.client.post(`/errands/${e.id}/accept`);
    await w.settle();
    await run.client.post(`/errands/${e.id}/start`);

    const d = await req.client.post('/disputes', { errand_id: e.id, reason: 'no_show', detail: 'He stopped answering an hour ago.' });
    expect(d.status).toBe(201);
    await w.settle();
    const detail = await req.client.get(`/errands/${e.id}`);
    expect(detail.body.status).toBe('disputed');
    expect(detail.body.escrow.frozen).toBe(true);
    expect(detail.body.card.voided).toBe(true);

    const reader = await w.staff(['ops.read', 'evidence.view']);
    const pack = await reader.client.get(`/ops/disputes/${d.body.id}/evidence`);
    expect(pack.status).toBe(200);
    const [audited] = await w.admin`SELECT count(*)::int AS n FROM audit_log WHERE action = 'dispute.evidence_view' AND subject = ${d.body.id}`;
    expect(audited.n).toBe(1);

    const ruling = { outcome: 'split', requester_cents: 0, runner_cents: 0, rationale: 'Runner started and went silent; requester refunded all but the time already spent.' };
    // Without legal_ops, refused at the gateway.
    expect((await reader.client.post(`/ops/disputes/${d.body.id}/rule`, ruling)).status).toBe(403);

    const officer = await w.staff(['ops.read', 'ledger.read', 'legal_ops']);
    const held = (await officer.client.get(`/ops/errands/${e.id}/trace`)).body.postings
      .filter((p: any) => p.account === 'escrow_hold').reduce((a: number, p: any) => a + p.amount_cents, 0);
    expect(held).toBeGreaterThan(0);
    // A split that does not add up to the escrow is refused.
    expect((await officer.client.post(`/ops/disputes/${d.body.id}/rule`, { ...ruling, requester_cents: held - 1, runner_cents: 5_000 })).status).toBe(400);
    // A short rationale is refused.
    expect((await officer.client.post(`/ops/disputes/${d.body.id}/rule`, { ...ruling, rationale: 'no', requester_cents: held })).status).toBe(400);

    const ok = await officer.client.post(`/ops/disputes/${d.body.id}/rule`, { ...ruling, requester_cents: held - 5_000, runner_cents: 5_000 });
    expect(ok.status).toBe(201);
    await w.settle();
    expect((await run.client.get('/earnings')).body.available_cents).toBe(5_000);
    const after = await req.client.get(`/errands/${e.id}`);
    expect(after.body.status).toBe('settled');
    expect(after.body.escrow.held_cents).toBe(0);
  });
});

describe('KYC review', () => {
  test('documents upload, submission is complete, ops approves, the tier rises', async () => {
    const u = await w.signIn({ role: 'runner', name: 'Wanjiku Mwangi' });
    const c = await u.client.post('/kyc/cases', { target_tier: 3 });
    expect(c.status).toBe(201);
    const early = await u.client.post(`/kyc/cases/${c.body.id}/submit`, {});
    expect(early.body.details.missing).toEqual(expect.arrayContaining(['id_front', 'selfie', 'conduct_cert', 'next_of_kin', 'movement_consent']));
    for (const slot of ['id_front', 'id_back', 'selfie', 'conduct_cert']) {
      const p = await u.client.post(`/kyc/cases/${c.body.id}/documents`, { slot, content_type: 'image/jpeg' });
      const url = new URL(p.body.upload_url);
      const put = await w.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from([1, 2, 3]) });
      expect(put.statusCode).toBe(200);
    }
    const sub = await u.client.post(`/kyc/cases/${c.body.id}/submit`, {
      id_number: '23456789', next_of_kin: { name: 'Grace Mwangi', msisdn: '0712345678' }, movement_consent: true,
    });
    expect(sub.body.status).toBe('submitted');

    // The identity number is sealed at rest.
    const [row] = await w.admin`SELECT id_number_enc FROM kyc_case WHERE id = ${c.body.id}`;
    expect(Buffer.from(row.id_number_enc).toString('utf8')).not.toContain('23456789');

    const reviewer = await w.staff(['ops.read', 'kyc.review']);
    const queue = await reviewer.client.get('/ops/kyc?status=submitted');
    expect(queue.body.data.some((k: any) => k.id === c.body.id)).toBe(true);
    const view = await reviewer.client.get(`/ops/kyc/${c.body.id}`);
    expect(view.body.id_number_masked).toBe('••••789');
    expect(view.body.next_of_kin.msisdn_masked).toBe('…678');
    expect(view.body.documents.selfie).toContain('/uploads/kyc/');

    expect((await reviewer.client.post(`/ops/kyc/${c.body.id}/decide`, { approve: true })).status).toBe(200);
    await w.refresh(u);
    const me = await u.client.get('/me');
    expect(me.body.verification_tier).toBe(3);
    expect(me.body.entitlements).toContain('errand.accept');
  });
});

describe('the link handshake and authenticated location', () => {
  test('both phones derive the same hash; fixes verify on the receiving phone; a forgery does not', async () => {
    const req = await w.requester('Linked Lena');
    const run = await w.runner('Linked Luke');
    const e = await openErrand(req);
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 30_000 });
    await run.client.post(`/errands/${e.id}/accept`);
    await w.settle();

    const rk = generateDeviceKeys(), nk = generateDeviceKeys();
    const rPub = rawPublicKey(rk.publicKey), nPub = rawPublicKey(nk.publicKey);
    await req.client.post(`/errands/${e.id}/link`, { public_key: rPub.toString('base64') });
    const nView = await run.client.post(`/errands/${e.id}/link`, { public_key: nPub.toString('base64') });
    expect(nView.body.state).toBe('pending_ack');

    const hash = linkHash(rPub, nPub, e.id).toString('base64');
    expect((await req.client.post(`/errands/${e.id}/link/ack`, { link_hash: Buffer.alloc(32).toString('base64') })).body.code).toBe('LINK_MISMATCH');
    await req.client.post(`/errands/${e.id}/link/ack`, { link_hash: hash });
    expect((await run.client.post(`/errands/${e.id}/link/ack`, { link_hash: hash })).body.state).toBe('active');

    const secret = deriveSecret(nk.privateKey, rPub);
    const fix = { lat: -1.2641, lng: 36.7519, accuracyM: 8, headingDeg: 90, recordedAt: new Date().toISOString() };
    const tag = tagFix(secret, e.id, 1, fix);
    const r = await run.client.post('/location', { fixes: [{
      errand_id: e.id, lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracyM, heading_deg: fix.headingDeg,
      seq: 1, hmac_tag: tag.toString('base64'), recorded_at: fix.recordedAt,
    }] });
    expect(r.body).toEqual({ accepted: 1, dropped: 0 });

    const loc = await req.client.get(`/errands/${e.id}/location`);
    expect(loc.body.state).toBe('live');
    // The requester's phone verifies with ITS derived secret — the server never had one.
    const mine = deriveSecret(rk.privateKey, nPub);
    const received = { ...fix, lat: loc.body.point.lat, lng: loc.body.point.lng };
    expect(verifyFix({ secret: mine, errandId: e.id, seq: loc.body.seq, fix: received, tag: Buffer.from(loc.body.hmac_tag, 'base64'), lastAcceptedSeq: 0, state: 'active' }))
      .toEqual({ ok: true });
    // A position the server (or anyone) altered fails on the phone.
    expect(verifyFix({ secret: mine, errandId: e.id, seq: loc.body.seq, fix: { ...received, lat: -1.3 }, tag: Buffer.from(loc.body.hmac_tag, 'base64'), lastAcceptedSeq: 0, state: 'active' }).ok)
      .toBe(false);

    // Replays at or below the last seq are dropped.
    const again = await run.client.post('/location', { fixes: [{ errand_id: e.id, lat: 0, lng: 0, accuracy_m: 1, seq: 1, hmac_tag: 'AAAA', recorded_at: new Date().toISOString() }] });
    expect(again.body).toEqual({ accepted: 0, dropped: 1 });

    const [audited] = await w.admin`SELECT count(*)::int AS n FROM audit_log WHERE action = 'location.read' AND subject = ${e.id}`;
    expect(audited.n).toBe(1);
  });
});

describe('chat and safety', () => {
  test('the two parties talk; markup is neutralised; SOS returns the market emergency number', async () => {
    const req = await w.requester('Chatty Cathy');
    const run = await w.runner('Chatty Charles');
    const e = await openErrand(req);
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 30_000 });
    await run.client.post(`/errands/${e.id}/accept`);
    await w.settle();
    await run.client.post(`/errands/${e.id}/messages`, { body: 'Tomatoes are <b>3 < 5</b> shillings today' });
    const list = await req.client.get(`/errands/${e.id}/messages`);
    expect(list.body.data[0].body).toBe('Tomatoes are ‹b›3 ‹ 5‹/b› shillings today');
    const sos = await req.client.post(`/errands/${e.id}/sos`, { lat: -1.29, lng: 36.78 });
    expect(sos.body).toMatchObject({ dial: 'tel:999', emergency_number: '999' });
  });
});

describe('the ledger after all of the above', () => {
  test('reconciles with no findings', async () => {
    await w.settle();
    const r = await reconcile({ sql: w.worker.sql, issuer: w.worker.issuer, page: async () => {}, ticket: async () => {} });
    expect(r.findings).toEqual([]);
  });
});

void randomUUID;
