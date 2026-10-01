// Regression tests for the security audit of feat/mvp-build. Each block is one finding: it
// failed (or could not be written) before the fix and passes after.

import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { redactUrl } from '@sidequest/observability';
import { signAccess } from '@sidequest/api/plugins/auth';
import webhookRoutes from '@sidequest/api/routes/webhooks.routes';
import { World } from './world.js';

let w: World;
beforeAll(async () => { w = await new World().start(); });
afterAll(async () => { await w.stop(); });

const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sid: string };

/** Open /ws, send the token, and resolve with the first thing that happens. */
async function socket(token: string, waitMs = 3000): Promise<{ event?: string; closed?: number }> {
  const ws = await w.app.injectWS('/ws');
  return new Promise((resolve) => {
    const done = (r: { event?: string; closed?: number }) => { clearTimeout(t); resolve(r); };
    const t = setTimeout(() => { ws.terminate(); resolve({}); }, waitMs);
    ws.on('message', (m) => done({ event: JSON.parse(String(m)).event }));
    ws.on('close', (code) => done({ closed: code }));
    ws.send(JSON.stringify({ token }));
  });
}

describe('1 · the realtime socket is bound to a live session', () => {
  test('a live session gets a socket', async () => {
    const u = await w.requester('Live Lina');
    expect(await socket(u.access)).toEqual({ event: 'ready' });
  });

  test('after logout, a still-unexpired access token cannot open one', async () => {
    const u = await w.requester('Logged-out Lou');
    expect((await u.client.post('/auth/logout')).status).toBe(204);
    expect(await socket(u.access)).toEqual({ closed: 4401 });
  });

  test('the socket closes when its access token expires, so it cannot outlive it', async () => {
    const u = await w.requester('Expiring Eve');
    const me = (await u.client.get('/me')).body;
    const short = await signAccess(w.cfg.JWT_SECRET, 1, {
      accountId: me.id, role: 'requester', tier: 1, staffGrants: [], sessionId: claims(u.access).sid,
    });
    const ws = await w.app.injectWS('/ws');
    const events: unknown[] = [];
    const closed = await new Promise<number>((resolve) => {
      ws.on('message', (m) => events.push(JSON.parse(String(m)).event));
      ws.on('close', (code) => resolve(code));
      ws.send(JSON.stringify({ token: short }));
    });
    expect(events).toEqual(['ready']);
    expect(closed).toBe(4402);
  });
});

describe('2, 6 · Daraja callbacks', () => {
  const callbacks = async () => (await w.admin`SELECT count(*)::int AS n FROM outbox_event WHERE queue = 'mpesa.callback'`)[0]!.n as number;
  const body = { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_probe', ResultCode: 0, ResultDesc: 'ok' } } };

  test('with the fake driver the routes accept nothing (it never calls them)', async () => {
    const before = await callbacks();
    const r = await w.app.inject({ method: 'POST', url: '/webhooks/daraja/anything/stk', payload: body });
    expect(r.statusCode).toBe(200);                 // never a 4xx/5xx to a webhook sender
    expect(await callbacks()).toBe(before);
  });

  test('live: a wrong token or a wrong source enqueues nothing; the right token from Safaricom does', async () => {
    const token = randomBytes(32).toString('base64url');
    const app = Fastify();
    app.decorate('deps', { cfg: { ...w.cfg, DARAJA_DRIVER: 'daraja', DARAJA_CALLBACK_TOKEN: token, DARAJA_SOURCE_CIDRS: ['196.201.214.0/24'] }, sql: w.apiDeps.sql } as never);
    app.addHook('onRequest', async (req) => { req.trustedIp = String(req.headers['x-test-ip'] ?? '196.201.214.10'); });
    await app.register(webhookRoutes);
    const post = (path: string, ip?: string) => app.inject({ method: 'POST', url: path, payload: body, headers: ip ? { 'x-test-ip': ip } : {} });

    const before = await callbacks();
    await post(`/webhooks/daraja/${'x'.repeat(token.length)}/stk`);
    await post('/webhooks/daraja/short/stk');
    await post(`/webhooks/daraja/${token}/stk`, '203.0.113.9');
    expect(await callbacks()).toBe(before);
    await post(`/webhooks/daraja/${token}/stk`);
    expect(await callbacks()).toBe(before + 1);
    await app.close();
  });

  test('a forged confirmation that got past the gate still credits nothing', async () => {
    const u = await w.requester('Forger Fred');
    await w.admin`INSERT INTO outbox_event (queue, payload) VALUES ('mpesa.callback', ${w.admin.json({
      kind: 'stk', body: { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_forged_2', ResultCode: 0, ResultDesc: 'ok',
        CallbackMetadata: { Item: [{ Name: 'Amount', Value: 100000 }] } } } },
    })})`;
    await w.settle();
    expect((await u.client.get('/wallet')).body.balance_cents).toBe(0);
    const [ev] = await w.admin`SELECT count(*)::int AS n FROM mpesa_event WHERE checkout_ref = 'ws_CO_forged_2'`;
    expect(ev!.n).toBe(1);   // recorded, and ignored
  });

  test('the callback token and upload signatures never reach the logs', () => {
    expect(redactUrl('/webhooks/daraja/s3cr3t-token/stk')).toBe('/webhooks/daraja/[redacted]/stk');
    expect(redactUrl('/uploads/evidence/a.jpg?exp=1&sig=abc123')).toBe('/uploads/evidence/a.jpg?exp=1&sig=[redacted]');
  });
});

describe('3 · cross-site writes compare whole origins', () => {
  // The console is the cookie-bearing client; ALLOWED_ORIGINS in the test env is
  // https://console.sidequest.test. A Referer is what a browser sends when Origin is absent.
  const write = (referer: string) => w.app.inject({
    method: 'POST', url: '/auth/refresh', payload: {}, headers: { cookie: 'sq_refresh=x', referer },
  });

  test('a look-alike host that merely starts with the allowed origin is refused', async () => {
    const r = await write('https://console.sidequest.test.evil.net/page');
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('CSRF_ORIGIN');
  });

  test('the real console passes the origin check', async () => {
    const r = await write('https://console.sidequest.test/disputes');
    expect(r.json().code).not.toBe('CSRF_ORIGIN');
  });
});

describe('4 · a signed upload is not capped at the JSON body ceiling', () => {
  test('a 600 KB photo uploads', async () => {
    const u = await w.signIn({ role: 'runner', name: 'Photo Paul' });
    const c = await u.client.post('/kyc/cases', { target_tier: 2 });
    const p = await u.client.post(`/kyc/cases/${c.body.id}/documents`, { slot: 'id_front', content_type: 'image/jpeg' });
    const url = new URL(p.body.upload_url);
    const put = await w.app.inject({
      method: 'PUT', url: url.pathname + url.search, headers: { 'content-type': 'image/jpeg' }, payload: randomBytes(600 * 1024),
    });
    expect(put.statusCode).toBe(200);
  });

  test('JSON routes keep the 256 KB ceiling', async () => {
    const u = await w.requester('Big Body');
    const r = await u.client.post('/disputes', { padding: 'x'.repeat(300 * 1024) });
    expect(r.status).toBe(413);
  });
});

describe('5 · a withdrawal already debited is not reserved twice', () => {
  test('with one withdrawal pending, the rest of the balance can still be withdrawn', async () => {
    const u = await w.requester('Withdrawing Wanjiru');
    await w.topUp(u, 100_000);
    expect((await u.client.post('/wallet/withdraw', { amount_cents: 50_000 })).status).toBe(202);
    await w.settle();
    // As if the B2C result had not come back yet: debited in the ledger, still pending.
    await w.admin`UPDATE payment SET status = 'pending' WHERE account_id = ${u.id} AND direction = 'out'`;
    expect((await u.client.get('/wallet')).body.balance_cents).toBe(50_000);
    const second = await u.client.post('/wallet/withdraw', { amount_cents: 50_000 });
    expect(second.status).toBe(202);
    // And still not a shilling more than there is.
    expect((await u.client.post('/wallet/withdraw', { amount_cents: 100 })).status).toBe(409);
  });
});

describe('7 · voiding a live card is a decision, not a read', () => {
  test('ops.read cannot void; legal_ops can reach the action', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const reader = await w.staff(['ops.read', 'ledger.read']);
    expect((await reader.client.post(`/ops/cards/${id}/void`, {})).status).toBe(403);
    const officer = await w.staff(['ops.read', 'legal_ops']);
    expect((await officer.client.post(`/ops/cards/${id}/void`, {})).status).toBe(404);
  });
});
