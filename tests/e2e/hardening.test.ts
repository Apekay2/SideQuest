// Regression tests for the production-readiness audit of 23 October 2026. Each block is one
// finding; it fails with the fix removed and passes with it.

import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { NoCardIssuer, type ConsoleSms } from '@sidequest/adapters';
import { insertPostingGroup } from '@sidequest/db';
import { withdraw } from '@sidequest/domain/ledger/posting';
import { cents } from '@sidequest/domain/money/money';
import { MpesaRejectedError, MpesaUnknownOutcomeError, type MpesaPort } from '@sidequest/domain/rails/mpesa.port';
import { buildWorkerDeps, drain } from '@sidequest/worker/runtime';
import { watchdog, SOS_MAX_PAGES } from '@sidequest/worker/jobs/safety';
import { unknownRetryDelaySeconds } from '@sidequest/worker/jobs/card-load.job';
import type { Alert } from '@sidequest/worker/alert';
import { World, marketRun, NAIROBI, type User } from './world.js';

const ONCALL = '+254700000101';
const w = new World();
beforeAll(async () => { await w.start({ SAFETY_ONCALL_MSISDNS: ONCALL }); });
afterAll(async () => { await w.stop(); });

/** A rail whose every request times out (or is refused), for the ambiguity tests. */
function rail(make: () => Error): MpesaPort {
  return {
    stkPush: async () => { throw make(); },
    payTill: async () => { throw make(); },
    b2c: async () => { throw make(); },
  };
}

/** Worker deps sharing the world's database and Redis, with some ports replaced. */
function workerWith(over: Parameters<typeof buildWorkerDeps>[1]) {
  return buildWorkerDeps(w.cfg, { redis: w.apiDeps.redis, sql: w.worker.sql, issuer: w.worker.issuer, ...over });
}

/**
 * Drain with custom deps until two quiet rounds (fake rail callbacks arrive on timers). Ladder
 * steps re-enqueue themselves a second or so out, so delays are fast-forwarded; every handler
 * re-checks its own clock where time matters.
 */
async function settleWith(deps: ReturnType<typeof workerWith>) {
  for (let quiet = 0; quiet < 2;) {
    const ran = await drain(deps, { ignoreDelay: true, only: ['errand.assigned', 'card.load', 'mpesa.callback', 'eta.recompute', 'checkpoint.record', 'notify'] });
    quiet = ran.length === 0 ? quiet + 1 : 0;
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function fund(u: User, body: Record<string, unknown>) {
  await w.topUp(u, 400_000);
  const e = await u.client.post('/errands', body);
  if (e.status !== 201) throw new Error(`create ${e.status} ${JSON.stringify(e.body)}`);
  await u.client.post(`/errands/${e.body.id}/publish`);
  const f = await u.client.post(`/errands/${e.body.id}/fund`, { rail: 'wallet' });
  if (f.status !== 200) throw new Error(`fund ${f.status} ${JSON.stringify(f.body)}`);
  return e.body;
}

const queueStand = (over: Record<string, unknown> = {}) => marketRun({
  kind: 'queue_stand', title: 'Stand in line at Huduma Centre', stalls: [], spend_cap_cents: 0, bonus_cents: 0,
  pickup: { ...NAIROBI.westlands, label: 'Huduma Centre GPO' }, ...over,
});

/** A basket-less errand taken all the way to handover, ready for the QR scan. */
async function atHandover(req: User, run: User, fee = 30_000) {
  const e = await fund(req, queueStand());
  await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: fee });
  await run.client.post(`/errands/${e.id}/accept`);
  await w.settle();
  await run.client.post(`/errands/${e.id}/start`);
  await run.client.post(`/errands/${e.id}/arrive`);
  const ready = await run.client.post(`/errands/${e.id}/ready`);
  if (ready.body.status !== 'handover') throw new Error(`ready ${ready.status} ${JSON.stringify(ready.body)}`);
  return e;
}

async function settled(req: User, run: User, fee = 30_000) {
  const e = await atHandover(req, run, fee);
  const tok = await req.client.get(`/errands/${e.id}/handover-token`);
  await run.client.post(`/errands/${e.id}/handover`, { qr_token: tok.body.qr_token });
  await w.settle();
  return e;
}

// ─────────────────────────────────────────────── M-Pesa outcomes we cannot see

describe('a rail timeout is not a refusal', () => {
  test('a payout whose B2C request timed out is left open, not reversed, and its late result confirms it', async () => {
    const req = await w.requester('Timeout Tess');
    const run = await w.runner('Timeout Tom');
    await settled(req, run);
    const before = (await run.client.get('/earnings')).body.available_cents;
    expect(before).toBeGreaterThanOrEqual(10_000);

    const p = await run.client.post('/payouts', { amount_cents: 10_000 });
    expect(p.status).toBe(202);
    await drain(workerWith({ mpesa: rail(() => new MpesaUnknownOutcomeError('timeout')) }), { only: ['payout.send'] });

    const [po] = await w.admin`SELECT status, failure_code, idem_key, provider_ref FROM payout WHERE id = ${p.body.id}`;
    // Reversing here would let the runner withdraw the same money again if Safaricom paid.
    expect(po).toMatchObject({ status: 'sent', failure_code: 'request_unconfirmed', provider_ref: null });
    expect((await run.client.get('/earnings')).body.available_cents).toBe(before - 10_000);

    // Safaricom's result arrives later, matched by the originator id we sent.
    await w.admin`INSERT INTO outbox_event (queue, payload) VALUES ('mpesa.callback', ${w.admin.json({
      kind: 'result', body: { Result: {
        ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: `b2c:${po.idem_key}`,
        ConversationID: 'AG_late_payout', TransactionID: 'LATE1',
        ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: 100 }] },
      } },
    })})`;
    await w.settle();
    const [after] = await w.admin`SELECT status, provider_ref FROM payout WHERE id = ${p.body.id}`;
    expect(after).toMatchObject({ status: 'confirmed', provider_ref: 'AG_late_payout' });
  });

  test('a payout Safaricom refused outright is reversed back into earnings', async () => {
    const req = await w.requester('Refused Rita');
    const run = await w.runner('Refused Ray');
    await settled(req, run);
    const before = (await run.client.get('/earnings')).body.available_cents;
    const p = await run.client.post('/payouts', { amount_cents: 10_000 });
    await drain(workerWith({ mpesa: rail(() => new MpesaRejectedError('rejected (400)', 400)) }), { only: ['payout.send'] });
    const [po] = await w.admin`SELECT status, failure_code FROM payout WHERE id = ${p.body.id}`;
    expect(po).toMatchObject({ status: 'failed', failure_code: 'request_failed' });
    expect((await run.client.get('/earnings')).body.available_cents).toBe(before);
  });

  test('a top-up whose push timed out is credited when its callback arrives, matched by payer and amount', async () => {
    const u = await w.requester('Paid Anyway Pam');
    const r = await u.client.post('/wallet/topup', { amount_cents: 50_000 });
    await drain(workerWith({ mpesa: rail(() => new MpesaUnknownOutcomeError('timeout')) }), { only: ['payment.stk'] });
    const [p] = await w.admin`SELECT status, failure_code, provider_ref FROM payment WHERE id = ${r.body.payment_id}`;
    // It used to be marked failed: a customer who then paid was never credited.
    expect(p).toMatchObject({ status: 'pending', failure_code: 'push_unconfirmed', provider_ref: null });

    await w.admin`INSERT INTO outbox_event (queue, payload) VALUES ('mpesa.callback', ${w.admin.json({
      kind: 'stk', body: { Body: { stkCallback: {
        MerchantRequestID: 'm1', CheckoutRequestID: 'ws_CO_never_seen', ResultCode: 0, ResultDesc: 'ok',
        CallbackMetadata: { Item: [
          { Name: 'Amount', Value: 500 }, { Name: 'MpesaReceiptNumber', Value: 'LATE2' },
          { Name: 'PhoneNumber', Value: Number(u.msisdn.replace('+', '')) },
        ] },
      } } },
    })})`;
    await w.settle();
    expect((await u.client.get('/wallet')).body.balance_cents).toBe(50_000);
    const [done] = await w.admin`SELECT status, provider_ref FROM payment WHERE id = ${r.body.payment_id}`;
    expect(done).toMatchObject({ status: 'confirmed', provider_ref: 'ws_CO_never_seen' });
  });

  test('an interrupted issuer load is re-asked less and less often, never every 5 s for ever', () => {
    expect(unknownRetryDelaySeconds(0)).toBe(5);
    expect(unknownRetryDelaySeconds(10 * 60_000)).toBe(100);
    expect(unknownRetryDelaySeconds(60 * 60_000)).toBe(300);
  });
});

// ─────────────────────────────────────────────── no card partner

describe('ISSUER_DRIVER=none: the ladder starts at the vendor till', () => {
  test('a stall is paid by M-Pesa till when no card can be loaded', async () => {
    const noCard = workerWith({ issuer: new NoCardIssuer() });
    const req = await w.requester('Tillfirst Tina');
    const run = await w.runner('Tillfirst Toby');
    const e = await fund(req, marketRun());
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 30_000 });
    await run.client.post(`/errands/${e.id}/accept`);
    await settleWith(noCard);
    await run.client.post(`/errands/${e.id}/start`);
    await run.client.post(`/errands/${e.id}/arrive`);
    const stall = e.stalls[0];   // till 174379
    await run.client.post(`/errands/${e.id}/stalls/${stall.id}/items`, {
      items: stall.items.map((it: any) => ({ id: it.id, price_cents: 10_000 })),
    });
    const ev = await run.client.post(`/errands/${e.id}/stalls/${stall.id}/evidence`, { kind: 'goods', content_type: 'image/jpeg', taken_at: new Date().toISOString() });
    const url = new URL(ev.body.upload_url);
    await w.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from([0xff, 0xd8]) });
    expect((await run.client.post(`/errands/${e.id}/stalls/${stall.id}/submit`)).status).toBe(204);
    expect((await req.client.post(`/errands/${e.id}/stalls/${stall.id}/approve`)).status).toBe(202);
    await settleWith(noCard);

    const t = (await req.client.get(`/errands/${e.id}/tranches`)).body.items[0];
    expect(t.status).toBe('loaded');
    expect(t.attempts.map((a: any) => `${a.rung}:${a.result}`)).toEqual(['card:declined', 'mpesa_till:success']);
    const [card] = await w.admin`SELECT loaded_cents::int AS loaded_cents, issuer_ref FROM card WHERE errand_id = ${e.id}`;
    expect(card).toMatchObject({ loaded_cents: 0, issuer_ref: `nocard:${e.id}` });
  });
});

// ─────────────────────────────────────────────── the ledger itself

describe('client money cannot go negative', () => {
  test('the database refuses a posting that would overdraw a wallet, whatever the caller checked', async () => {
    const u = await w.requester('Empty Eddie');
    const err = await w.worker.sql.begin((tx) =>
      insertPostingGroup(tx, withdraw({ userId: u.id, amountCents: cents(100), currency: 'KES' }))).catch((e) => e);
    expect(err?.code).toBe('23514');
    expect(String(err?.message)).toMatch(/client money would go negative/);
  });
});

// ─────────────────────────────────────────────── errand integrity

describe('money does not move on a frozen errand', () => {
  test('a stall cannot be approved while its errand is disputed', async () => {
    const req = await w.requester('Frozen Fiona');
    const run = await w.runner('Frozen Fred');
    const e = await fund(req, marketRun());
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 30_000 });
    await run.client.post(`/errands/${e.id}/accept`);
    await w.settle();
    await run.client.post(`/errands/${e.id}/start`);
    await run.client.post(`/errands/${e.id}/arrive`);
    const stall = e.stalls[1];
    await run.client.post(`/errands/${e.id}/stalls/${stall.id}/items`, { items: [{ id: stall.items[0].id, price_cents: 20_000 }] });
    const ev = await run.client.post(`/errands/${e.id}/stalls/${stall.id}/evidence`, { kind: 'goods', content_type: 'image/jpeg', taken_at: new Date().toISOString() });
    const url = new URL(ev.body.upload_url);
    await w.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from([0xff, 0xd8]) });
    await run.client.post(`/errands/${e.id}/stalls/${stall.id}/submit`);

    expect((await req.client.post('/disputes', { errand_id: e.id, reason: 'overcharged', detail: 'Beans are not 200 a kilo.' })).status).toBe(201);
    const approve = await req.client.post(`/errands/${e.id}/stalls/${stall.id}/approve`);
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe('ERRAND_STATE_INVALID');
    const [s] = await w.admin`SELECT spent_cents FROM errand WHERE id = ${e.id}`;
    expect(Number(s.spent_cents)).toBe(0);
  });
});

describe('an offer\'s fee binds only the runner it was offered to', () => {
  test('after a declined offer, claiming an open errand pays the ceiling everyone saw', async () => {
    const req = await w.requester('Ceiling Cece');
    const lowballed = await w.runner('Lowballed Liam');
    const claimer = await w.runner('Claiming Clara');
    const e = await fund(req, marketRun({ assignment_mode: 'open', max_fee_cents: 40_000 }));
    await req.client.post(`/errands/${e.id}/offer`, { runner_id: lowballed.id, fee_cents: 15_000 });
    expect((await lowballed.client.post(`/errands/${e.id}/decline-offer`)).status).toBe(204);
    const a = await claimer.client.post(`/errands/${e.id}/accept`);
    expect(a.status).toBe(200);
    // It used to be 15,000: the declined offer's fee was COALESCEd into the claim.
    expect(a.body.agreed_fee_cents).toBe(40_000);
  });
});

describe('disputes have an end', () => {
  test('once a ruling closes a dispute, the errand cannot be disputed again', async () => {
    const req = await w.requester('Again Agnes');
    const run = await w.runner('Again Arno');
    const e = await settled(req, run);
    const d = await req.client.post('/disputes', { errand_id: e.id, reason: 'other', detail: 'He was rude at the door.' });
    expect(d.status).toBe(201);
    await w.settle();
    const officer = await w.staff(['ops.read', 'ledger.read', 'legal_ops']);
    const r = await officer.client.post(`/ops/disputes/${d.body.id}/rule`, {
      outcome: 'void', requester_cents: 0, runner_cents: 0,
      rationale: 'Conduct complaint noted on the runner record; no money was in dispute after settlement.',
    });
    expect(r.status).toBe(201);
    await w.settle();
    // settled → disputed → settled used to repeat for as long as a party liked.
    const again = await req.client.post('/disputes', { errand_id: e.id, reason: 'other', detail: 'Still unhappy about it.' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_RULED');
  });

  test('a settled errand can be disputed only within the window after handover', async () => {
    const req = await w.requester('Late Lucy');
    const run = await w.runner('Late Larry');
    const e = await settled(req, run);
    await w.admin`UPDATE errand SET handover_at = now() - make_interval(hours => ${w.cfg.DISPUTE_WINDOW_HOURS + 1}) WHERE id = ${e.id}`;
    const d = await req.client.post('/disputes', { errand_id: e.id, reason: 'goods_wrong', detail: 'Remembered it weeks later.' });
    expect(d.status).toBe(409);
    expect(d.body.code).toBe('DISPUTE_WINDOW_CLOSED');
  });
});

// ─────────────────────────────────────────────── stuck errands

describe('the watchdog hands a stuck errand to Legal Operations', () => {
  test('an errand sitting in handover for over a day is disputed by the system and frozen', async () => {
    const req = await w.requester('Absent Abby');
    const run = await w.runner('Waiting Walter');
    const e = await atHandover(req, run);
    await w.admin`UPDATE errand SET updated_at = now() - interval '25 hours', deadline_at = now() - interval '26 hours' WHERE id = ${e.id}`;
    const alerts: Alert[] = [];
    const raised = await watchdog({ sql: w.worker.sql, alert: async (a) => { alerts.push(a); } });
    expect(raised).toContain(e.id);
    expect(alerts.some((a) => a.data?.errand_id === e.id)).toBe(true);

    const [d] = await w.admin`SELECT raised_by, origin, status FROM dispute WHERE errand_id = ${e.id}`;
    expect(d).toMatchObject({ raised_by: null, origin: 'system', status: 'open' });
    await w.settle();
    const detail = await req.client.get(`/errands/${e.id}`);
    expect(detail.body.status).toBe('disputed');
    expect(detail.body.escrow.frozen).toBe(true);
    // A second pass does not open a second dispute.
    expect(await watchdog({ sql: w.worker.sql, alert: async () => {} })).not.toContain(e.id);
  });

  test('an errand scheduled for later is not stuck while it waits for its deadline', async () => {
    const req = await w.requester('Planner Petra');
    const run = await w.runner('Booked Ben');
    const e = await atHandover(req, run);
    await w.admin`UPDATE errand SET updated_at = now() - interval '25 hours', deadline_at = now() + interval '2 days' WHERE id = ${e.id}`;
    expect(await watchdog({ sql: w.worker.sql, alert: async () => {} })).not.toContain(e.id);
  });

  test('a live errand that is merely slow is left alone', async () => {
    const req = await w.requester('Patient Pia');
    const run = await w.runner('Slow Sam');
    const e = await atHandover(req, run);
    await w.admin`UPDATE errand SET updated_at = now() - interval '2 hours' WHERE id = ${e.id}`;
    expect(await watchdog({ sql: w.worker.sql, alert: async () => {} })).not.toContain(e.id);
  });
});

// ─────────────────────────────────────────────── SOS

describe('an SOS pages a person until someone acknowledges it', () => {
  const pages = () => (w.worker.sms as ConsoleSms).outbox.filter((m) => m.msisdn === ONCALL && m.text.includes('SOS'));

  test('the on-call is paged at once, then every minute — and the paging is bounded', async () => {
    const req = await w.requester('Scared Sara');
    const run = await w.runner('Sos Steve');
    const e = await atHandover(req, run);
    const start = pages().length;
    const sos = await req.client.post(`/errands/${e.id}/sos`, { lat: -1.29, lng: 36.78 });
    expect(sos.status).toBe(201);
    await w.settle({ only: ['sos.opened'] });
    expect(pages().length).toBe(start + 1);
    // Fast-forward every re-page timer: it stops at SOS_MAX_PAGES, it does not loop.
    await w.settle({ ignoreDelay: true, only: ['sos.escalate'] });
    expect(pages().length).toBe(start + SOS_MAX_PAGES);
    const [c] = await w.admin`SELECT escalations FROM sos_case WHERE id = ${sos.body.sos_id}`;
    expect(c.escalations).toBe(SOS_MAX_PAGES);
  });

  test('once acknowledged in the console, the paging stops', async () => {
    const req = await w.requester('Calmer Cara');
    const run = await w.runner('Sos Sid');
    const e = await atHandover(req, run);
    const sos = await req.client.post(`/errands/${e.id}/sos`, {});
    await w.settle({ only: ['sos.opened'] });
    const after1 = pages().length;
    const ops = await w.staff(['ops.read']);
    expect((await ops.client.post(`/ops/sos/${sos.body.sos_id}/acknowledge`, {})).status).toBe(200);
    await w.settle({ ignoreDelay: true, only: ['sos.escalate'] });
    expect(pages().length).toBe(after1);
  });
});

// ─────────────────────────────────────────────── privacy

describe('the feed is not a location oracle for a requester\'s door', () => {
  test('an errand with no pickup is placed at its res-8 cell centre, not the door', async () => {
    const req = await w.requester('Private Priya');
    const runner = await w.runner('Probing Paul');
    const e = await fund(req, marketRun({
      kind: 'document_drop', title: 'Drop a letter', stalls: [], spend_cap_cents: 0, bonus_cents: 0, pickup: undefined,
      dropoff: { lat: -1.2989, lng: 36.7912, label: 'Home, Kilimani' },
    }));
    const [c] = await w.admin`
      SELECT ST_Y(g) AS lat, ST_X(g) AS lng,
             ST_Distance(g::geography, ST_SetSRID(ST_MakePoint(36.7912, -1.2989), 4326)::geography) AS door_to_centre
        FROM (SELECT h3_cell_to_geometry(h3_cell_to_parent(dropoff_cell, 8)) AS g FROM errand WHERE id = ${e.id}) x`;
    const atCentre = await runner.client.get(`/feed?lat=${c.lat}&lng=${c.lng}&radius_m=200`);
    expect(atCentre.status).toBe(200);
    const item = atCentre.body.data.find((f: any) => f.id === e.id);
    // Found at the cell centre, as close as it gets — wherever in the cell the door really is.
    expect(item?.distance_band).toBe('under_500m');
    expect(Number(c.door_to_centre)).toBeGreaterThan(0);
  });

  test('runner discovery reports a res-8 cell, never the finer res-9', async () => {
    const req = await w.requester('Mapping Mo');
    const run = await w.runner('Mapped Mike');
    expect((await run.client.post('/presence', { lat: NAIROBI.westlands.lat, lng: NAIROBI.westlands.lng, available: true })).status).toBe(204);
    const e = await fund(req, marketRun({ pickup: { ...NAIROBI.westlands, label: 'Sarit Centre' } }));
    const near = await req.client.get(`/runners/nearby?errand_id=${e.id}`);
    expect(near.status).toBe(200);
    const me = near.body.runners.find((r: any) => r.runner_id === run.id);
    expect(me).toBeDefined();
    expect(me).not.toHaveProperty('cell_r9');
    const [res] = await w.admin`SELECT h3_get_resolution(${me.cell_r8}::h3index) AS r`;
    expect(res.r).toBe(8);
  });

  test('metrics answer only a private address', async () => {
    const pub = await w.app.inject({ method: 'GET', url: '/health/metrics', remoteAddress: '203.0.113.5' });
    expect(pub.statusCode).toBe(404);
    const priv = await w.app.inject({ method: 'GET', url: '/health/metrics', remoteAddress: '10.20.30.40' });
    expect(priv.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────── sessions and abuse

describe('one account cannot hold unlimited sockets', () => {
  test('the sixth socket closes the oldest', async () => {
    const u = await w.requester('Many Tabs');
    const closes: number[] = [];
    const sockets = [];
    for (let i = 0; i < 6; i++) {
      const ws = await w.app.injectWS('/ws');
      ws.on('close', (code) => closes.push(code));
      await new Promise<void>((resolve) => { ws.once('message', () => resolve()); ws.send(JSON.stringify({ token: u.access })); });
      sockets.push(ws);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(closes).toEqual([4409]);
    for (const s of sockets) s.terminate();
  });
});

describe('ops access follows the account, not a 15-minute-old token', () => {
  test('a removed grant stops working on the next request', async () => {
    const officer = await w.staff(['ops.read']);
    expect((await officer.client.get('/ops/overview')).status).toBe(200);
    await w.admin`UPDATE account SET staff_grants = '{}' WHERE id = ${officer.id}`;
    expect((await officer.client.get('/ops/overview')).status).toBe(403);
  });

  test('a suspended officer is signed out of the console at once', async () => {
    const officer = await w.staff(['ops.read']);
    await w.admin`UPDATE account SET suspended_at = now() WHERE id = ${officer.id}`;
    expect((await officer.client.get('/ops/overview')).status).toBe(401);
  });
});

describe('an abandoned idempotency key does not leave a client waiting for ever', () => {
  test('a key claimed by a request that never finished is reported abandoned after its lease', async () => {
    const u = await w.requester('Crashed Carl');
    const key = randomUUID();
    const body = { amount_cents: 10_000 };
    const route = 'POST /wallet/topup';
    const hash = createHash('sha256').update(route).update('\0').update('/wallet/topup').update('\0').update(JSON.stringify(body)).digest('hex');
    await w.admin`INSERT INTO idempotency_key (account_id, key, route, request_hash, created_at)
                  VALUES (${u.id}, ${key}, ${route}, ${hash}, now() - interval '5 minutes')`;
    const r = await u.client.post('/wallet/topup', body, { idem: key });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('IDEMPOTENCY_ABANDONED');
  });
});
