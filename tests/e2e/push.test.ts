// Push notifications end to end: the app registers its Expo token, a real flow (an offer)
// queues a notification, the worker delivers it through the push driver with the errand id
// for the tap, and a device the push service reports gone is revoked.

import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { ConsolePush } from '@sidequest/adapters';
import { World, marketRun, type User } from './world.js';

let w: World;
let push: ConsolePush;
beforeAll(async () => { w = await new World().start(); push = w.worker.push as ConsolePush; });
afterAll(async () => { await w.stop(); });
beforeEach(() => { push.sent.length = 0; push.gone.clear(); });

const token = () => `ExponentPushToken[${randomBytes(16).toString('base64url')}]`;

async function offerTo(req: User, run: User) {
  await w.topUp(req, 400_000);
  const e = (await req.client.post('/errands', marketRun())).body;
  await req.client.post(`/errands/${e.id}/publish`);
  await req.client.post(`/errands/${e.id}/fund`, { rail: 'wallet' });
  await req.client.post(`/errands/${e.id}/offer`, { runner_id: run.id, fee_cents: 30_000 });
  await w.settle();
  return e;
}

describe('push notifications', () => {
  test('a registered device gets the offer, on the errand channel, carrying the errand id for the tap', async () => {
    const req = await w.requester('Push Requester');
    const run = await w.runner('Push Runner');
    const t = token();
    expect((await run.client.post('/me/push-token', { token: t, platform: 'android' })).status).toBe(204);
    const e = await offerTo(req, run);
    const mine = push.sent.filter((m) => m.to === t);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'Side Qwest', channelId: 'errand', data: { template: 'errand.offered', errandId: e.id } });
    expect(mine[0]!.body).toContain('offer');
  });

  test('only Expo tokens are accepted', async () => {
    const u = await w.requester('Bad Token');
    expect((await u.client.post('/me/push-token', { token: 'fcm:abc123', platform: 'android' })).status).toBe(400);
    expect((await u.client.post('/me/push-token', { token: token(), platform: 'web' })).status).toBe(400);
  });

  test('a shared phone: the token follows whoever signed in last, and the first person stops receiving', async () => {
    const req = await w.requester('Shared Phone Req');
    const first = await w.runner('First Owner');
    const second = await w.runner('Second Owner');
    const t = token();
    await first.client.post('/me/push-token', { token: t, platform: 'ios' });
    expect((await second.client.post('/me/push-token', { token: t, platform: 'ios' })).status).toBe(204);
    await offerTo(req, first);
    expect(push.sent.filter((m) => m.to === t)).toHaveLength(0);
    const [row] = await w.admin`SELECT account_id FROM push_token WHERE token = ${t}`;
    expect(row!.account_id).toBe(second.id);
  });

  test('signing out removes the device; a device reported gone is revoked and not tried again', async () => {
    const req = await w.requester('Gone Req');
    const run = await w.runner('Gone Runner');
    const kept = token(), left = token(), gone = token();
    for (const t of [kept, left, gone]) await run.client.post('/me/push-token', { token: t, platform: 'android' });
    expect((await run.client.delete('/me/push-token', { token: left })).status).toBe(204);
    push.gone.add(gone);
    await offerTo(req, run);
    expect(push.sent.map((m) => m.to)).toContain(kept);
    expect(push.sent.map((m) => m.to)).not.toContain(left);
    const [g] = await w.admin`SELECT revoked_at FROM push_token WHERE token = ${gone}`;
    expect(g!.revoked_at).not.toBeNull();
    const [l] = await w.admin`SELECT count(*)::int AS n FROM push_token WHERE token = ${left}`;
    expect(l!.n).toBe(0);
  });

  test('nobody can read or delete another person\'s device', async () => {
    const owner = await w.requester('Device Owner');
    const other = await w.requester('Device Thief');
    const t = token();
    await owner.client.post('/me/push-token', { token: t, platform: 'ios' });
    await other.client.delete('/me/push-token', { token: t });
    const [row] = await w.admin`SELECT account_id FROM push_token WHERE token = ${t}`;
    expect(row!.account_id).toBe(owner.id);
  });
});
