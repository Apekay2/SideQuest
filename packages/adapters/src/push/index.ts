// packages/adapters/src/push/index.ts
// Push delivery through Expo's push service, which fronts both APNs (iOS) and FCM (Android)
// for an Expo app. The worker calls this from the notify job; the in-app copy (socket) and the
// SMS copy for money/decision messages are unchanged, so push failing never loses a message.

import { logger } from '@sidequest/observability';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Read by the app when the notification is tapped (e.g. { errandId } opens that errand). */
  data?: Record<string, string>;
  /** Android notification channel; the app creates these at startup (platform/adaptive.ts). */
  channelId?: 'money' | 'errand' | 'chat' | 'marketing';
}

/** Per message, in order: delivered to the push service, or why not. */
export type PushOutcome = { ok: true } | { ok: false; error: string; deviceGone: boolean };

export interface PushPort {
  send(messages: PushMessage[]): Promise<PushOutcome[]>;
}

/** Development and tests: records what would have been sent. */
export class ConsolePush implements PushPort {
  readonly sent: PushMessage[] = [];
  /** Tokens to report as uninstalled, to exercise the revocation path in tests. */
  readonly gone = new Set<string>();
  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    return messages.map((m) => {
      if (this.gone.has(m.to)) return { ok: false, error: 'DeviceNotRegistered', deviceGone: true };
      this.sent.push(m);
      logger.info({ to: `${m.to.slice(0, 22)}…`, title: m.title, channel: m.channelId }, 'push (console driver)');
      return { ok: true };
    });
  }
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH = 100;   // Expo's per-request limit

export class ExpoPush implements PushPort {
  /** accessToken: required when the Expo project enforces "enhanced push security". */
  constructor(private readonly cfg: { accessToken?: string; fetcher?: typeof fetch } = {}) {}

  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    const out: PushOutcome[] = [];
    for (let i = 0; i < messages.length; i += BATCH) {
      const batch = messages.slice(i, i + BATCH);
      const res = await (this.cfg.fetcher ?? fetch)(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json', 'content-type': 'application/json',
          ...(this.cfg.accessToken ? { authorization: `Bearer ${this.cfg.accessToken}` } : {}),
        },
        body: JSON.stringify(batch.map((m) => ({ ...m, sound: 'default', priority: 'high' }))),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // The whole request failed (auth, rate limit, outage): every message in it failed, none
        // is a dead device. The caller keeps the in-app and SMS copies.
        for (const _ of batch) out.push({ ok: false, error: `push service ${res.status}`, deviceGone: false });
        continue;
      }
      const json = (await res.json()) as { data?: { status: 'ok' | 'error'; message?: string; details?: { error?: string } }[] };
      batch.forEach((_, j) => {
        const t = json.data?.[j];
        if (t?.status === 'ok') out.push({ ok: true });
        else {
          const error = t?.details?.error ?? t?.message ?? 'no ticket';
          out.push({ ok: false, error, deviceGone: error === 'DeviceNotRegistered' });
        }
      });
    }
    return out;
  }
}
