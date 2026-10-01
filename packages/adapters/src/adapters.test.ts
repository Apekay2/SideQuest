import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCallback, ipInCidrs, FakeMpesa } from './mpesa/index.js';
import { LocalStorage } from './storage/index.js';
import { cents } from '@sidequest/domain/money/money';

describe('daraja callbacks', () => {
  it('parses a successful STK callback, amount in cents', () => {
    const r = parseCallback('stk', { Body: { stkCallback: {
      CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok',
      CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1500 }, { Name: 'MpesaReceiptNumber', Value: 'QK12' }] },
    } } });
    expect(r).toEqual({ kind: 'stk', ref: 'ws_CO_1', ok: true, resultCode: '0', resultDesc: 'ok', amountCents: 150000, receipt: 'QK12' });
  });

  it('tells a till result from a payout by the originator prefix', () => {
    const till = parseCallback('result', { Result: { ConversationID: 'AG_1', OriginatorConversationID: 'till:x', ResultCode: 0 } });
    const b2c = parseCallback('result', { Result: { ConversationID: 'AG_2', OriginatorConversationID: 'b2c:x', ResultCode: 0 } });
    expect(till?.kind).toBe('till');
    expect(b2c?.kind).toBe('b2c');
  });

  it('returns null for junk rather than throwing', () => {
    expect(parseCallback('stk', { hello: 'world' })).toBeNull();
    expect(parseCallback('result', null)).toBeNull();
  });

  it('the fake produces bodies the real parser accepts', async () => {
    const got: unknown[] = [];
    const fake = new FakeMpesa(async (kind, body) => { got.push(parseCallback(kind, body)); }, 1);
    const { checkoutRef } = await fake.stkPush({ msisdn: '+254722000111', amountCents: cents(150000), accountRef: 'x', description: 'x', idemKey: 'k' });
    await new Promise((r) => setTimeout(r, 20));
    expect(got[0]).toMatchObject({ kind: 'stk', ref: checkoutRef, ok: true, amountCents: 150000 });
  });

  it('refuses a non-whole-shilling amount before it reaches the rail', async () => {
    const fake = new FakeMpesa(async () => {}, 1);
    await expect(fake.b2c({ msisdn: '+254722000111', amountCents: cents(150050), remarks: 'x', idemKey: 'k' }))
      .rejects.toThrow(/whole shillings/);
  });
});

describe('source allowlist', () => {
  it('matches IPv4 and IPv4-mapped IPv6 within a CIDR', () => {
    expect(ipInCidrs('196.201.214.200', ['196.201.214.0/24'])).toBe(true);
    expect(ipInCidrs('::ffff:196.201.214.9', ['196.201.214.0/24'])).toBe(true);
    expect(ipInCidrs('196.201.215.1', ['196.201.214.0/24'])).toBe(false);
    expect(ipInCidrs('not-an-ip', ['0.0.0.0/0'])).toBe(false);
  });
});

describe('local storage signing', () => {
  const store = new LocalStorage(mkdtempSync(join(tmpdir(), 'sq-')), 'http://localhost:3000', 'k'.repeat(40));

  it('accepts its own signature and refuses a tampered key or content type', async () => {
    const { url } = await store.presignPut('kyc/a/b/selfie.jpg', 'image/jpeg', 60);
    const u = new URL(url);
    const exp = Number(u.searchParams.get('exp')), sig = u.searchParams.get('sig')!;
    expect(store.verify('PUT', 'kyc/a/b/selfie.jpg', exp, sig, 'image/jpeg')).toBe(true);
    expect(store.verify('PUT', 'kyc/a/c/selfie.jpg', exp, sig, 'image/jpeg')).toBe(false);
    expect(store.verify('PUT', 'kyc/a/b/selfie.jpg', exp, sig, 'image/svg+xml')).toBe(false);
    expect(store.verify('GET', 'kyc/a/b/selfie.jpg', exp, sig)).toBe(false);
  });

  it('refuses an expired URL', () => {
    expect(store.verify('GET', 'x', Math.floor(Date.now() / 1000) - 1, 'sig')).toBe(false);
  });

  it('refuses a key that escapes the root', async () => {
    await expect(store.write('../../etc/x', Buffer.from('x'))).rejects.toThrow(/escapes/);
  });
});

describe('push', async () => {
  const { ExpoPush } = await import('./push/index.js');
  it('Expo tickets map to outcomes in order; DeviceNotRegistered marks the device gone', async () => {
    const fetcher = (async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as unknown[];
      expect(sent).toHaveLength(3);
      return new Response(JSON.stringify({ data: [
        { status: 'ok', id: 'a' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } },
      ] }));
    }) as unknown as typeof fetch;
    const out = await new ExpoPush({ fetcher }).send(['A', 'B', 'C'].map((t) => ({ to: `ExponentPushToken[${t}xxxxxxxxxx]`, title: 'Side Qwest', body: 'hi' })));
    expect(out).toEqual([
      { ok: true },
      { ok: false, error: 'DeviceNotRegistered', deviceGone: true },
      { ok: false, error: 'MessageTooBig', deviceGone: false },
    ]);
  });

  it('a failed request fails every message in it without blaming the devices', async () => {
    const fetcher = (async () => new Response('busy', { status: 429 })) as unknown as typeof fetch;
    const out = await new ExpoPush({ fetcher }).send([{ to: 'ExponentPushToken[xxxxxxxxxxxx]', title: 't', body: 'b' }]);
    expect(out).toEqual([{ ok: false, error: 'push service 429', deviceGone: false }]);
  });
});
