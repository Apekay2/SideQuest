// A market run from sign-in to payout, through the real API and the real worker, with the
// ledger checked at the end by the real reconciliation job. This is the path every other
// test is a variation on.

import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { World, marketRun, type User } from './world.js';
import { reconcile } from '@sidequest/worker/jobs/reconcile.job';
import { splitFee, depositTotal } from '@sidequest/domain/pricing/fees';
import { cents } from '@sidequest/domain/money/money';
import type { MockIssuer } from '@sidequest/adapters';

const w = new World();
let amina: User, peter: User, errandId: string;
const stalls: { id: string; items: { id: string; label: string }[] }[] = [];

beforeAll(async () => { await w.start(); });
afterAll(async () => { await w.stop(); });

describe('market run, end to end', () => {
  test('both people sign in; the runner is tier 3', async () => {
    amina = await w.requester('Amina Wanjiru');
    peter = await w.runner('Peter Kamau');
    const me = await peter.client.get('/me');
    expect(me.body.verification_tier).toBe(3);
    expect(me.body.entitlements).toContain('errand.accept');
  });

  test('the requester tops up through M-Pesa and the webhook path credits the wallet', async () => {
    await w.topUp(amina, 250_000);
    const wallet = await amina.client.get('/wallet');
    expect(wallet.body.balance_cents).toBe(250_000);
  });

  test('she posts a market run with two stalls, publishes and funds it from the wallet', async () => {
    const created = await amina.client.post('/errands', marketRun());
    expect(created.status).toBe(201);
    errandId = created.body.id;
    expect(created.body.stalls).toHaveLength(2);
    for (const s of created.body.stalls) stalls.push({ id: s.id, items: s.items });

    const expected = depositTotal({ agreedFeeCents: cents(40_000), goodsCapCents: cents(100_000), bonusCents: cents(5_000) }).depositCents;
    expect(created.body.deposit_cents).toBe(expected);

    expect((await amina.client.post(`/errands/${errandId}/publish`)).body.status).toBe('awaiting_funds');
    const funded = await amina.client.post(`/errands/${errandId}/fund`, { rail: 'wallet' });
    expect(funded.status).toBe(200);
    expect(funded.body.status).toBe('open');
    expect((await amina.client.get('/wallet')).body.balance_cents).toBe(250_000 - expected);
  });

  test('the runner finds it in the feed, banded, and bids blind', async () => {
    const feed = await peter.client.get(`/feed?lat=${-1.2645}&lng=${36.7525}`);
    expect(feed.status).toBe(200);
    const item = feed.body.data.find((f: any) => f.id === errandId);
    expect(item.distance_band).toBe('under_500m');
    expect(item).not.toHaveProperty('dropoff');

    const bid = await peter.client.post(`/errands/${errandId}/bids`, { fee_cents: 30_000, eta_minutes: 45, note: 'I know Mama Ngina' });
    expect(bid.status).toBe(201);
  });

  test('bids stay sealed until close, then she awards', async () => {
    const sealed = await amina.client.get(`/errands/${errandId}/bids`);
    expect(sealed.body).toMatchObject({ sealed: true, count: 1 });
    expect(sealed.body.bids).toBeUndefined();

    const early = await amina.client.post(`/errands/${errandId}/award`, { bid_id: '00000000-0000-4000-8000-000000000000' });
    expect(early.status).toBe(404);

    await w.closeAuction(errandId);
    const open = await amina.client.get(`/errands/${errandId}/bids`);
    expect(open.body.sealed).toBe(false);
    expect(open.body.bids[0].runner.display_name).toBe('Peter Kamau');

    const award = await amina.client.post(`/errands/${errandId}/award`, { bid_id: open.body.bids[0].id });
    expect(award.status).toBe(200);
    expect(award.body.agreed_fee_cents).toBe(30_000);
  });

  test('assignment issues a one-time card for the errand', async () => {
    await w.settle();
    const d = await amina.client.get(`/errands/${errandId}`);
    expect(d.body.status).toBe('awarded');
    expect(d.body.card.last4).toMatch(/^\d{4}$/);
    expect(d.body.fee).toEqual({ requester_fee_cents: 1_800, runner_fee_cents: 1_800 });
    expect(d.body.runner.display_name).toBe('Peter Kamau');
  });

  test('the runner starts, arrives, prices stall 1 and photographs it', async () => {
    expect((await peter.client.post(`/errands/${errandId}/start`)).body.status).toBe('en_route');
    expect((await peter.client.post(`/errands/${errandId}/arrive`)).body.status).toBe('shopping');

    const s1 = stalls[0]!;
    const prices = [6_000, 18_000, 14_000];
    const priced = await peter.client.post(`/errands/${errandId}/stalls/${s1.id}/items`, {
      items: s1.items.map((it, i) => ({ id: it.id, price_cents: prices[i] })),
    });
    expect(priced.body.total_cents).toBe(38_000);

    const ev = await peter.client.post(`/errands/${errandId}/stalls/${s1.id}/evidence`, {
      kind: 'goods', content_type: 'image/jpeg', taken_at: new Date().toISOString(), lat: -1.2641, lng: 36.7519,
    });
    expect(ev.status).toBe(201);
    const url = new URL(ev.body.upload_url);
    const put = await w.app.inject({
      method: 'PUT', url: url.pathname + url.search, headers: { 'content-type': 'image/jpeg' },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]),
    });
    expect(put.statusCode).toBe(200);

    expect((await peter.client.post(`/errands/${errandId}/stalls/${s1.id}/submit`)).status).toBe(204);
  });

  test('she sees the photo and approves: 202, never optimistic', async () => {
    const d = await amina.client.get(`/errands/${errandId}`);
    expect(d.body.status).toBe('awaiting_approval');
    const s1 = d.body.stalls.find((s: any) => s.seq === 1);
    expect(s1.status).toBe('photographed');
    expect(s1.photo_url).toContain('/uploads/evidence/');

    const approve = await amina.client.post(`/errands/${errandId}/stalls/${s1.id}/approve`);
    expect(approve.status).toBe(202);
    expect(approve.body.tranche).toMatchObject({ amount_cents: 38_000, status: 'pending' });
    expect(approve.body.remaining_cap_cents).toBe(62_000);
  });

  test('the worker loads the card and the tranche reads loaded', async () => {
    await w.settle();
    const t = await peter.client.get(`/errands/${errandId}/tranches`);
    expect(t.body.items[0]).toMatchObject({ status: 'loaded', amount_cents: 38_000 });
    expect(t.body.items[0].attempts[0]).toMatchObject({ rung: 'card', result: 'success' });
  });

  test('the runner pays the stall with the card', async () => {
    const [c] = await w.admin<{ issuer_ref: string }[]>`SELECT issuer_ref FROM card WHERE errand_id = ${errandId}`;
    await (w.worker.issuer as MockIssuer).simulateSpend(c!.issuer_ref, 38_000);
    expect(Number(await w.worker.issuer.getBalance(c!.issuer_ref))).toBe(0);
  });

  test('stall 2: the card declines, there is no till, and the requester agrees to reimburse cash', async () => {
    const s2 = stalls[1]!;
    // 113 shillings: the mock issuer hard-declines amounts ending in 13.
    await peter.client.post(`/errands/${errandId}/stalls/${s2.id}/items`, { items: [{ id: s2.items[0]!.id, price_cents: 11_300 }] });
    const ev = await peter.client.post(`/errands/${errandId}/stalls/${s2.id}/evidence`, {
      kind: 'goods', content_type: 'image/jpeg', taken_at: new Date().toISOString(),
    });
    const url = new URL(ev.body.upload_url);
    await w.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from([0xff, 0xd8, 9]) });
    await peter.client.post(`/errands/${errandId}/stalls/${s2.id}/submit`);
    const approve = await amina.client.post(`/errands/${errandId}/stalls/${s2.id}/approve`);
    expect(approve.status).toBe(202);

    // The ladder schedules each rung a moment after the last; fast-forward through them.
    await w.settle({ ignoreDelay: true });
    let t = (await amina.client.get(`/errands/${errandId}/tranches`)).body.items.find((x: any) => x.seq === 2);
    expect(t.status).toBe('pending');
    expect(t.attempts.map((a: any) => `${a.rung}:${a.result}`)).toEqual(['card:declined', 'reimbursement:pending']);

    const ok = await amina.client.post(`/errands/${errandId}/reimbursement/confirm`, { tranche_id: t.id, accept: true });
    expect(ok.status).toBe(200);
    await w.settle({ ignoreDelay: true });
    t = (await amina.client.get(`/errands/${errandId}/tranches`)).body.items.find((x: any) => x.seq === 2);
    expect(t.status).toBe('loaded');
  });

  test('with every stall resolved the errand moves to handover', async () => {
    const d = await amina.client.get(`/errands/${errandId}`);
    expect(d.body.status).toBe('handover');
  });

  test('a stale or forged QR code is refused; the fresh one settles the errand', async () => {
    const bad = await peter.client.post(`/errands/${errandId}/handover`, { qr_token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(bad.status).toBe(400);
    const tok = await amina.client.get(`/errands/${errandId}/handover-token`);
    expect(tok.status).toBe(200);
    const ok = await peter.client.post(`/errands/${errandId}/handover`, { qr_token: tok.body.qr_token });
    expect(ok.body.status).toBe('settled');
    const again = await peter.client.post(`/errands/${errandId}/handover`, { qr_token: tok.body.qr_token });
    expect(again.status).toBe(409);
  });

  test('settlement pays the runner fee less 6%, the bonus in full and the cash back', async () => {
    await w.settle();
    const split = splitFee(cents(30_000));
    const earnings = await peter.client.get('/earnings');
    expect(earnings.body.available_cents).toBe(30_000 - split.runnerFeeCents + 5_000 + 11_300);
    expect(earnings.body.reimbursements_owed_cents).toBe(0);
  });

  test('the requester gets back everything she did not spend', async () => {
    const deposit = depositTotal({ agreedFeeCents: cents(40_000), goodsCapCents: cents(100_000), bonusCents: cents(5_000) }).depositCents;
    const spent = 30_000 + 1_800 + 5_000 + 38_000 + 11_300;
    const wallet = await amina.client.get('/wallet');
    expect(wallet.body.balance_cents).toBe(250_000 - deposit + (deposit - spent));
    expect(wallet.body.escrow).toHaveLength(0);
    const d = await amina.client.get(`/errands/${errandId}`);
    expect(d.body.card.voided).toBe(true);
    expect(d.body.escrow.held_cents).toBe(0);
  });

  test('the runner cashes out to M-Pesa', async () => {
    const before = (await peter.client.get('/earnings')).body.available_cents;
    const p = await peter.client.post('/payouts', { amount_cents: 20_000 });
    expect(p.status).toBe(202);
    await w.settle();
    const e = await peter.client.get('/earnings');
    expect(e.body.available_cents).toBe(before - 20_000);
    expect(e.body.payouts[0]).toMatchObject({ amount_cents: 20_000, status: 'confirmed' });
  });

  test('the whole ledger reconciles with no findings', async () => {
    const r = await reconcile({ sql: w.worker.sql, issuer: w.worker.issuer, page: async () => {}, ticket: async () => {} });
    expect(r.findings).toEqual([]);
    expect(r.checksRun).toBeGreaterThan(15);
  });
});
