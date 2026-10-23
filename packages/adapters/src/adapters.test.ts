import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCallback, ipInCidrs, FakeMpesa, Daraja } from './mpesa/index.js';
import { MockIssuer, NoCardIssuer } from './issuer/index.js';
import { MpesaRejectedError, MpesaUnknownOutcomeError, isDefinitiveRejection } from '@sidequest/domain/rails/mpesa.port';
import { afterEach, vi } from 'vitest';
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

  it('carries the originator on a till or B2C result, and ignores the payer number Safaricom masks', () => {
    const stk = parseCallback('stk', { Body: { stkCallback: {
      CheckoutRequestID: 'ws_CO_2', ResultCode: 0,
      CallbackMetadata: { Item: [{ Name: 'Amount', Value: 10 }, { Name: 'PhoneNumber', Value: '0722***111' }] },
    } } });
    expect(stk).toMatchObject({ kind: 'stk', ref: 'ws_CO_2', ok: true, amountCents: 1000 });
    expect(stk).not.toHaveProperty('msisdn');
    const b2c = parseCallback('result', { Result: { ConversationID: 'AG_3', OriginatorConversationID: 'b2c:payout:abc', ResultCode: 0 } });
    expect(b2c?.originator).toBe('b2c:payout:abc');
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

  it('the fake produces bodies the real parser accepts, and hands back the push reference as the URL would', async () => {
    const got: unknown[] = [];
    const refs: (string | undefined)[] = [];
    const fake = new FakeMpesa(async (kind, body, pushRef) => { got.push(parseCallback(kind, body)); refs.push(pushRef); }, 1);
    const { checkoutRef } = await fake.stkPush({ msisdn: '+254722000111', amountCents: cents(150000), accountRef: 'x', description: 'x', idemKey: 'k' });
    await new Promise((r) => setTimeout(r, 20));
    expect(got[0]).toMatchObject({ kind: 'stk', ref: checkoutRef, ok: true, amountCents: 150000 });
    expect(refs[0]).toBe('k');
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


// ─────────────────────────────────────────────── production readiness audit

describe('Daraja failures are classified, so a timeout is never treated as a refusal', () => {
  const daraja = () => new Daraja({
    env: 'sandbox', consumerKey: 'ck', consumerSecret: 'cs', shortcode: '600000', passkey: 'pk',
    initiator: 'init', securityCredential: 'cred', callbackBase: 'https://api.example.test', callbackToken: 'tok',
  });
  const token = () => new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }), { status: 200 });
  const b2c = (d: Daraja) => d.b2c({ msisdn: '+254722000111', amountCents: cents(10_000), remarks: 'x', idemKey: 'k' });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a timeout is an unknown outcome', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(token())
      .mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })));
    const err = await b2c(daraja()).catch((e) => e);
    expect(err).toBeInstanceOf(MpesaUnknownOutcomeError);
    expect(isDefinitiveRejection(err)).toBe(false);
  });

  it('a 5xx or an unreadable body is an unknown outcome', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 })));
    expect(await b2c(daraja()).catch((e) => e)).toBeInstanceOf(MpesaUnknownOutcomeError);
  });

  it('a 4xx or a non-zero ResponseCode is a rejection', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response(JSON.stringify({ errorCode: '400.002.02', errorMessage: 'Bad Request' }), { status: 400 })));
    const err = await b2c(daraja()).catch((e) => e);
    expect(err).toBeInstanceOf(MpesaRejectedError);
    expect(isDefinitiveRejection(err)).toBe(true);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response(JSON.stringify({ ResponseCode: '1', ResponseDescription: 'no' }), { status: 200 })));
    expect(await b2c(daraja()).catch((e) => e)).toBeInstanceOf(MpesaRejectedError);
  });

  it('a failed token request is a rejection: nothing was sent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })));
    expect(await b2c(daraja()).catch((e) => e)).toBeInstanceOf(MpesaRejectedError);
  });

  it('an unrecognised error is never treated as a rejection', () => {
    expect(isDefinitiveRejection(new Error('socket hang up'))).toBe(false);
  });

  it('an STK push puts its payment id on the callback URL, so a timed-out push can still be matched', async () => {
    const id = '6f1c2b9e-3d4a-4b8c-9e2f-1a2b3c4d5e6f';
    const fetcher = vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response(JSON.stringify({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_9' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const out = await daraja().stkPush({ msisdn: '+254722000111', amountCents: cents(10_000), accountRef: 'x', description: 'x', idemKey: id });
    expect(out).toEqual({ checkoutRef: 'ws_CO_9' });
    const sent = JSON.parse(String((fetcher.mock.calls[1]![1] as RequestInit).body));
    expect(sent.CallBackURL).toBe(`https://api.example.test/webhooks/daraja/tok/stk/${id}`);
  });
});

describe('card issuers', () => {
  it('the no-card issuer declines every load terminally, so the ladder moves to the till', async () => {
    const i = new NoCardIssuer();
    const c = await i.createCard({ errandId: 'e1', ceilingCents: cents(1000), holderName: 'x', idemKey: 'card:e1' });
    expect(c.issuerRef).toBe('nocard:e1');
    expect(await i.loadCard()).toMatchObject({ ok: false, retryable: false, code: 'card_unavailable' });
    expect(await i.voidCard()).toEqual({ sweptCents: 0 });
  });

  it('the mock issuer sweeps on void, atomically and idempotently', async () => {
    // A tiny in-memory stand-in for the three Redis commands the mock uses.
    const kv = new Map<string, string>();
    const hashes = new Map<string, Record<string, string>>();
    const redis = {
      get: async (k: string) => kv.get(k) ?? null,
      set: async (k: string, v: string, nx?: string) => { if (nx === 'NX' && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
      hset: async (k: string, v: Record<string, string>) => { hashes.set(k, { ...(hashes.get(k) ?? {}), ...v }); return 1; },
      hgetall: async (k: string) => hashes.get(k) ?? {},
      hget: async (k: string, f: string) => hashes.get(k)?.[f] ?? null,
      hincrby: async (k: string, f: string, by: number) => { const h = hashes.get(k)!; h[f] = String(Number(h[f] ?? 0) + by); return Number(h[f]); },
      eval: async (_script: string, _n: number, cardKey: string, voidKey: string) => {
        if (kv.has(voidKey)) return Number(kv.get(voidKey));
        const bal = Number(hashes.get(cardKey)?.balance ?? 0);
        hashes.set(cardKey, { ...(hashes.get(cardKey) ?? {}), voided: '1', balance: '0' });
        kv.set(voidKey, String(bal));
        return bal;
      },
    };
    const i = new MockIssuer(redis as never);
    const c = await i.createCard({ errandId: 'e2', ceilingCents: cents(10_000), holderName: 'x', idemKey: 'card:e2' });
    expect(await i.loadCard({ issuerRef: c.issuerRef, amountCents: cents(10_000), idemKey: 'l1' })).toMatchObject({ ok: true });
    await i.simulateSpend(c.issuerRef, 3_000);
    expect(await i.voidCard({ issuerRef: c.issuerRef, idemKey: 'void:e2' })).toEqual({ sweptCents: 7_000 });
    // A retried void answers the same amount, so a crash between void and commit loses nothing.
    expect(await i.voidCard({ issuerRef: c.issuerRef, idemKey: 'void:e2' })).toEqual({ sweptCents: 7_000 });
    // And nothing can be spent on a closed card.
    await expect(i.simulateSpend(c.issuerRef, 1)).rejects.toThrow();
  });
});
