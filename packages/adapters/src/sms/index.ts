// packages/adapters/src/sms/index.ts
// SMS is the fallback channel when push cannot be assumed (01-architecture: nobody in this
// market has an email-first identity, and not every phone keeps a push token alive).

import { logger } from '@sidequest/observability';

export interface SmsPort {
  send(msisdn: string, text: string): Promise<{ providerRef: string | null }>;
}

/**
 * Development only: prints the message so an OTP can be read off the terminal. The number is
 * masked to its last three digits even here — terminal scrollback ends up in bug reports.
 */
export class ConsoleSms implements SmsPort {
  readonly outbox: { msisdn: string; text: string }[] = [];
  async send(msisdn: string, text: string) {
    this.outbox.push({ msisdn, text });
    logger.info({ to: `…${msisdn.slice(-3)}`, text }, 'sms (console driver)');
    return { providerRef: null };
  }
}

export class AfricasTalkingSms implements SmsPort {
  constructor(private readonly cfg: { username: string; apiKey: string; senderId: string; sandbox: boolean }) {}

  async send(msisdn: string, text: string) {
    const host = this.cfg.sandbox ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const body = new URLSearchParams({ username: this.cfg.username, to: msisdn, message: text, from: this.cfg.senderId });
    const res = await fetch(`https://${host}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey: this.cfg.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Africa's Talking responded ${res.status}`);
    const json = (await res.json()) as { SMSMessageData?: { Recipients?: { messageId?: string; status?: string }[] } };
    const r = json.SMSMessageData?.Recipients?.[0];
    if (!r || r.status !== 'Success') throw new Error(`SMS not accepted: ${r?.status ?? 'no recipient'}`);
    return { providerRef: r.messageId ?? null };
  }
}
