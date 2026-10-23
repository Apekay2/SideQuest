// apps/worker/src/alert.ts
// Getting a person's attention. Before this, "page" meant a fatal log line: nothing paged
// anyone, so an SOS, a failed reconciliation or a parked money job waited for someone to read
// the logs. Every page-worthy event now goes through here: it is logged, counted, and posted
// to ALERT_WEBHOOK_URL (the on-call tool's incoming webhook) when one is configured.
//
// Alerts carry identifiers only — an SOS id, an errand id, a count. Never a phone number, a
// name or a location: an alert channel is read by more people than the console is.

import type { Config } from '@sidequest/config';
import { logger, metrics } from '@sidequest/observability';

export type AlertSeverity = 'page' | 'ticket';

export interface Alert {
  severity: AlertSeverity;
  /** One line a person woken at 03:00 can act on. */
  title: string;
  detail?: string;
  /** Identifiers and counts only. */
  data?: Record<string, string | number | boolean | null>;
}

export type Alerter = (a: Alert) => Promise<void>;

/** Never throws: failing to alert must not fail the job that is reporting the problem. */
export function makeAlerter(cfg: Pick<Config, 'ALERT_WEBHOOK_URL' | 'NODE_ENV'>, fetcher: typeof fetch = fetch): Alerter {
  return async (a) => {
    const log = a.severity === 'page' ? logger.fatal.bind(logger) : logger.error.bind(logger);
    log({ alert: a }, a.title);
    metrics.increment('alert.raised', { severity: a.severity });
    if (!cfg.ALERT_WEBHOOK_URL) return;
    try {
      const res = await fetcher(cfg.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // `text` is what Slack-style incoming webhooks render; the rest is for tools that parse.
          text: `[${a.severity.toUpperCase()}] ${a.title}${a.detail ? ` — ${a.detail}` : ''}`,
          service: 'sidequest', environment: cfg.NODE_ENV, at: new Date().toISOString(), ...a,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`alert webhook answered ${res.status}`);
    } catch (err) {
      logger.error({ err }, 'alert webhook failed');
      metrics.increment('alert.webhook_failed');
    }
  };
}
