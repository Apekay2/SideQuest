// App-store review sign-in: one configured number signs in with a fixed code and no SMS, keeps
// every OTP limit, and never reaches the ops console.

import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'vitest';
import { World } from './world.js';

let w: World;
beforeAll(async () => { w = await new World().start({ REVIEW_LOGIN_MSISDN: '+254700000123', REVIEW_LOGIN_CODE: '482915' }); });
afterAll(async () => { await w.stop(); });
// One review number serves every test here, so each starts with its OTP limiter empty; the
// limits themselves are exercised in the lockout test.
beforeEach(async () => {
  const keys = await w.apiDeps.redis.keys('rl:otp*');
  if (keys.length) await w.apiDeps.redis.del(...keys);
});

describe('app-review sign-in', () => {
  test('the review number signs in with the fixed code, and no SMS is sent', async () => {
    const anon = w.anon();
    const before = w.sms().outbox.length;
    const otp = await anon.post('/auth/otp', { msisdn: '0700000123' }, { idem: false });
    expect(otp.status).toBe(201);
    expect(w.sms().outbox.length).toBe(before);
    const v = await anon.post('/auth/verify', { challenge_id: otp.body.challenge_id, code: '482915', role: 'requester', display_name: 'App Review' }, { idem: false });
    expect(v.status).toBe(200);
    expect(v.body.account.role).toBe('requester');
  });

  test('a wrong code still fails and still counts toward the lockout', async () => {
    const anon = w.anon();
    const otp = await anon.post('/auth/otp', { msisdn: '0700000123' }, { idem: false });
    for (let i = 0; i < 3; i++) {
      // Refused either way: a wrong code (400) or, once the per-number limit is spent, 429.
      expect([400, 429]).toContain((await anon.post('/auth/verify', { challenge_id: otp.body.challenge_id, code: '000000' }, { idem: false })).status);
    }
    const locked = await anon.post('/auth/verify', { challenge_id: otp.body.challenge_id, code: '482915' }, { idem: false });
    expect([400, 429]).toContain(locked.status);
  });

  test('every other number still gets a random code by SMS', async () => {
    const before = w.sms().outbox.length;
    await w.anon().post('/auth/otp', { msisdn: '0700000124' }, { idem: false });
    expect(w.sms().outbox.length).toBe(before + 1);
    expect(w.sms().outbox.at(-1)!.text).not.toContain('482915');
  });

  test('even if made staff, the review number never signs in to the console', async () => {
    await w.admin`UPDATE account SET role = 'staff', staff_grants = '{ops.read}' WHERE msisdn = '+254700000123'`;
    const anon = w.anon();
    const otp = await anon.post('/auth/otp', { msisdn: '0700000123' }, { idem: false });
    const v = await anon.post('/auth/verify', { challenge_id: otp.body.challenge_id, code: '482915', staff_only: true }, { idem: false });
    expect(v.status).toBe(403);
    expect(v.body.code).toBe('NOT_STAFF');
  });
});
