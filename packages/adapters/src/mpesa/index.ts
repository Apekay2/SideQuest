// packages/adapters/src/mpesa/index.ts
// Daraja (Safaricom M-Pesa) and a fake with the same shape.
//
// Both drivers hand outcomes to the same parser, `parseCallback`, which is also what the
// webhook route calls. The fake builds real Daraja callback bodies, so in development the
// parsing path is the production parsing path.

import { randomUUID } from 'node:crypto';
import type { MpesaPort, MpesaResult } from '@sidequest/domain/rails/mpesa.port';
import { toShillings } from '@sidequest/domain/rails/mpesa.port';
import { logger } from '@sidequest/observability';

// ─────────────────────────────────────────────── callback parsing

type Item = { Name: string; Value?: string | number };

/**
 * Turn a Daraja callback body into an MpesaResult. Returns null for anything that does not
 * look like one of the three shapes we asked for — the webhook still answers 200 (a 500 to
 * Safaricom triggers a retry storm) but records nothing actionable.
 */
export function parseCallback(kind: 'stk' | 'result', body: unknown): MpesaResult | null {
  if (!body || typeof body !== 'object') return null;
  if (kind === 'stk') {
    const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } }).Body?.stkCallback;
    if (!cb || typeof cb.CheckoutRequestID !== 'string') return null;
    const items = ((cb.CallbackMetadata as { Item?: Item[] } | undefined)?.Item) ?? [];
    const get = (n: string) => items.find((i) => i.Name === n)?.Value;
    const amount = get('Amount');
    return {
      kind: 'stk',
      ref: cb.CheckoutRequestID,
      ok: String(cb.ResultCode) === '0',
      resultCode: String(cb.ResultCode),
      resultDesc: String(cb.ResultDesc ?? ''),
      amountCents: typeof amount === 'number' ? Math.round(amount * 100) : null,
      receipt: typeof get('MpesaReceiptNumber') === 'string' ? String(get('MpesaReceiptNumber')) : null,
    };
  }
  const r = (body as { Result?: Record<string, unknown> }).Result;
  if (!r || typeof r.ConversationID !== 'string') return null;
  const params = ((r.ResultParameters as { ResultParameter?: { Key: string; Value: unknown }[] } | undefined)
    ?.ResultParameter) ?? [];
  const amount = params.find((p) => p.Key === 'TransactionAmount' || p.Key === 'Amount')?.Value;
  // The originator id carries our rail prefix so a till result and a payout result, which
  // share this callback shape, cannot be confused.
  const originator = String(r.OriginatorConversationID ?? '');
  return {
    kind: originator.startsWith('till:') ? 'till' : 'b2c',
    ref: r.ConversationID,
    ok: String(r.ResultCode) === '0',
    resultCode: String(r.ResultCode),
    resultDesc: String(r.ResultDesc ?? ''),
    amountCents: typeof amount === 'number' ? Math.round(amount * 100) : null,
    receipt: typeof r.TransactionID === 'string' ? r.TransactionID : null,
  };
}

// ─────────────────────────────────────────────── fake

export type Deliver = (kind: 'stk' | 'result', body: unknown) => Promise<void>;

/**
 * Development and test driver. Every call succeeds, except these deterministic failures so
 * the unhappy paths can be driven from the app:
 *   - an STK amount ending in 13 shillings is cancelled by the "customer" (ResultCode 1032)
 *   - a till payment to till 000000 fails (the vendor's till is not registered)
 *   - a B2C to a number ending 999 fails (receiver not registered)
 */
export class FakeMpesa implements MpesaPort {
  constructor(private readonly deliver: Deliver, private readonly delayMs = 800) {}

  private later(kind: 'stk' | 'result', body: unknown) {
    setTimeout(() => {
      this.deliver(kind, body).catch((err) => logger.error({ err }, 'fake mpesa delivery failed'));
    }, this.delayMs).unref?.();
  }

  async stkPush(args: Parameters<MpesaPort['stkPush']>[0]) {
    const shillings = toShillings(args.amountCents);
    const checkoutRef = `ws_CO_${randomUUID()}`;
    const cancelled = shillings % 100 === 13;
    this.later('stk', {
      Body: { stkCallback: {
        MerchantRequestID: randomUUID(), CheckoutRequestID: checkoutRef,
        ResultCode: cancelled ? 1032 : 0,
        ResultDesc: cancelled ? 'Request cancelled by user' : 'The service request is processed successfully.',
        ...(cancelled ? {} : { CallbackMetadata: { Item: [
          { Name: 'Amount', Value: shillings },
          { Name: 'MpesaReceiptNumber', Value: `FAKE${Date.now().toString(36).toUpperCase()}` },
          { Name: 'PhoneNumber', Value: Number(args.msisdn.replace('+', '')) },
        ] } }),
      } },
    });
    return { checkoutRef };
  }

  async payTill(args: Parameters<MpesaPort['payTill']>[0]) {
    const shillings = toShillings(args.amountCents);
    const conversationId = `AG_${randomUUID()}`;
    const failed = args.tillNumber === '000000';
    this.later('result', { Result: {
      ResultType: 0, ResultCode: failed ? 2001 : 0,
      ResultDesc: failed ? 'The initiator information is invalid.' : 'The service request is processed successfully.',
      OriginatorConversationID: `till:${args.idemKey}`, ConversationID: conversationId,
      TransactionID: failed ? undefined : `FAKET${Date.now().toString(36).toUpperCase()}`,
      ResultParameters: { ResultParameter: [{ Key: 'Amount', Value: shillings }] },
    } });
    return { conversationId };
  }

  async b2c(args: Parameters<MpesaPort['b2c']>[0]) {
    const shillings = toShillings(args.amountCents);
    const conversationId = `AG_${randomUUID()}`;
    const failed = args.msisdn.endsWith('999');
    this.later('result', { Result: {
      ResultType: 0, ResultCode: failed ? 2040 : 0,
      ResultDesc: failed ? 'Receiver is not a registered M-Pesa customer' : 'The service request is processed successfully.',
      OriginatorConversationID: `b2c:${args.idemKey}`, ConversationID: conversationId,
      TransactionID: failed ? undefined : `FAKEB${Date.now().toString(36).toUpperCase()}`,
      ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: shillings }] },
    } });
    return { conversationId };
  }
}

// ─────────────────────────────────────────────── Daraja

export interface DarajaConfig {
  env: 'sandbox' | 'production';
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  initiator: string;
  securityCredential: string;
  callbackBase: string;
}

export class Daraja implements MpesaPort {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private readonly cfg: DarajaConfig) {}

  private get host() {
    return this.cfg.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString('base64');
    const res = await fetch(`${this.host}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Daraja auth failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: string };
    this.token = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in) * 1000 };
    return this.token.value;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.host}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { errorMessage?: string; ResponseCode?: string };
    // Provider messages are logged, never echoed to a client (09-appsec §error scrubbing).
    if (!res.ok || (json.ResponseCode !== undefined && json.ResponseCode !== '0')) {
      logger.warn({ path, status: res.status, err: json.errorMessage }, 'daraja request rejected');
      throw new Error(`Daraja ${path} rejected (${res.status})`);
    }
    return json;
  }

  private timestamp(): string {
    // Daraja wants yyyyMMddHHmmss in East Africa Time.
    const eat = new Date(Date.now() + 3 * 3600_000);
    return eat.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  }

  async stkPush(args: Parameters<MpesaPort['stkPush']>[0]) {
    const ts = this.timestamp();
    const phone = args.msisdn.replace('+', '');
    const json = await this.post<{ CheckoutRequestID: string }>('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: this.cfg.shortcode,
      Password: Buffer.from(`${this.cfg.shortcode}${this.cfg.passkey}${ts}`).toString('base64'),
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: toShillings(args.amountCents),
      PartyA: phone,
      PartyB: this.cfg.shortcode,
      PhoneNumber: phone,
      CallBackURL: `${this.cfg.callbackBase}/webhooks/daraja/stk`,
      AccountReference: args.accountRef.slice(0, 12),
      TransactionDesc: args.description.slice(0, 13),
    });
    return { checkoutRef: json.CheckoutRequestID };
  }

  async payTill(args: Parameters<MpesaPort['payTill']>[0]) {
    const json = await this.post<{ ConversationID: string }>('/mpesa/b2b/v1/paymentrequest', {
      Initiator: this.cfg.initiator,
      SecurityCredential: this.cfg.securityCredential,
      CommandID: 'BusinessBuyGoods',
      SenderIdentifierType: '4',
      RecieverIdentifierType: '2',
      Amount: toShillings(args.amountCents),
      PartyA: this.cfg.shortcode,
      PartyB: args.tillNumber,
      AccountReference: args.reference.slice(0, 12),
      Remarks: 'Side Qwest stall',
      QueueTimeOutURL: `${this.cfg.callbackBase}/webhooks/daraja/timeout`,
      ResultURL: `${this.cfg.callbackBase}/webhooks/daraja/b2c/result`,
      OriginatorConversationID: `till:${args.idemKey}`,
    });
    return { conversationId: json.ConversationID };
  }

  async b2c(args: Parameters<MpesaPort['b2c']>[0]) {
    const json = await this.post<{ ConversationID: string }>('/mpesa/b2c/v3/paymentrequest', {
      OriginatorConversationID: `b2c:${args.idemKey}`,
      InitiatorName: this.cfg.initiator,
      SecurityCredential: this.cfg.securityCredential,
      CommandID: 'BusinessPayment',
      Amount: toShillings(args.amountCents),
      PartyA: this.cfg.shortcode,
      PartyB: args.msisdn.replace('+', ''),
      Remarks: args.remarks.slice(0, 100),
      QueueTimeOutURL: `${this.cfg.callbackBase}/webhooks/daraja/timeout`,
      ResultURL: `${this.cfg.callbackBase}/webhooks/daraja/b2c/result`,
      Occasion: 'SideQwest',
    });
    return { conversationId: json.ConversationID };
  }
}

// ─────────────────────────────────────────────── source check

/** IPv4 CIDR membership. Callbacks from outside Safaricom's ranges are dropped unread. */
export function ipInCidrs(ip: string, cidrs: readonly string[]): boolean {
  const v4 = ip.replace(/^::ffff:/, '');
  const toInt = (s: string) => s.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return false;
  const n = toInt(v4);
  return cidrs.some((c) => {
    const [base, bits = '32'] = c.split('/');
    if (!base || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (n & mask) === (toInt(base) & mask);
  });
}
