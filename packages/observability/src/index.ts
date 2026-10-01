// packages/observability/src/index.ts
// Structured logging with redaction, and in-process metrics. The scrubber is shared by the
// logger and the API error handler, so an msisdn or a coordinate cannot leave through either.

import pino from 'pino';

/** Keys whose values never appear in a log line or an error body. */
const REDACT_KEYS = new Set([
  'msisdn', 'phone', 'lat', 'lng', 'point', 'otp', 'refresh', 'access', 'token',
  'authorization', 'cookie', 'id_number', 'next_of_kin', 'qr_token', 'hmac_tag', 'secret',
]);

const MSISDN_RE = /\+?254\d{9}\b|\b0[17]\d{8}\b/g;

/** Deep-copy a value with sensitive keys replaced and phone numbers masked in strings. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(MSISDN_RE, '[msisdn]');
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.SERVICE_NAME ?? 'sidequest' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.msisdn', '*.lat', '*.lng',
            '*.otp', '*.refresh', '*.access', '*.token', '*.qr_token'],
    censor: '[redacted]',
  },
  formatters: { level: (label) => ({ level: label }) },
});

export type Logger = typeof logger;

/**
 * A request URL with its secrets removed: the Daraja callback token (a path segment) and the
 * signature on a signed upload link. Request URLs are logged on every request.
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url
    .replace(/^\/webhooks\/daraja\/[^/?]+/, '/webhooks/daraja/[redacted]')
    .replace(/([?&](?:sig|token)=)[^&]*/g, '$1[redacted]');
}

// ─────────────────────────────────────────────── metrics

type Labels = Record<string, string | number>;
const counters = new Map<string, number>();
const gauges = new Map<string, number>();

function key(name: string, labels?: Labels): string {
  if (!labels) return name;
  const parts = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v}"`);
  return `${name}{${parts.join(',')}}`;
}

export const metrics = {
  increment(name: string, labels?: Labels, by = 1): void {
    const k = key(name, labels);
    counters.set(k, (counters.get(k) ?? 0) + by);
  },
  gauge(name: string, value: number, labels?: Labels): void {
    gauges.set(key(name, labels), value);
  },
  /** Prometheus text exposition, for the internal /metrics endpoint. */
  render(): string {
    const lines: string[] = [];
    for (const [k, v] of counters) lines.push(`${k.replace(/\./g, '_')} ${v}`);
    for (const [k, v] of gauges) lines.push(`${k.replace(/\./g, '_')} ${v}`);
    return lines.join('\n') + '\n';
  },
  snapshot(): Record<string, number> {
    return Object.fromEntries([...counters, ...gauges]);
  },
};
