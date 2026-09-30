// packages/config/src/env.ts
// The only file in the repo that reads process.env. Everything else takes config as an
// argument. Invalid config fails at boot, loudly, before a single request is served.
//
// Secrets hygiene, enforced here rather than by convention:
//   - No secret has a default. A missing secret is a boot failure, never a weak fallback —
//     a default JWT_SECRET is a hardcoded credential with extra steps.
//   - Every secret is checked for placeholder and low-entropy values, so `changeme` cannot
//     reach production because someone copied the sample file.
//   - Secret-bearing fields are branded and redacted, so a whole-config log line (which
//     happens, usually in a boot banner or a Sentry breadcrumb) prints [redacted].
//   - CI greps the repo for these names with a literal value; see 09-appsec-audit.md §3.

import { z } from 'zod';

/** Values people paste into a sample file and forget. Any of these is a boot failure. */
const PLACEHOLDERS = [
  'changeme', 'change_me', 'secret', 'password', 'test', 'todo', 'xxx', 'placeholder',
  'your-key-here', 'sk_test', 'dummy', 'example', 'localhost-only', 'insecure',
];

/** A secret string: no default, minimum length, rejected if it looks like a placeholder or
 *  carries too few distinct characters to be random. */
function secret(minLen = 32) {
  return z.string().min(minLen, `must be at least ${minLen} characters`).superRefine((v, ctx) => {
    const low = v.toLowerCase();
    if (PLACEHOLDERS.some((p) => low.includes(p))) {
      ctx.addIssue({ code: 'custom', message: 'looks like a placeholder value' });
    }
    if (new Set(v).size < 12) {
      ctx.addIssue({ code: 'custom', message: 'too few distinct characters to be a real secret' });
    }
    if (/^[A-Za-z]+$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: 'looks like a word, not generated material' });
    }
  });
}

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().default(3000),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).default(20),
  REDIS_URL: z.string().url(),

  JWT_SECRET: secret(48),
  JWT_TTL_SECONDS: z.coerce.number().int().max(900).default(900),   // never longer than 15 min
  REFRESH_TTL_DAYS: z.coerce.number().int().max(90).default(30),
  COOKIE_SECRET: secret(32),
  KYC_ENCRYPTION_KEY: secret(32),
  /** Key id from the KMS/Secrets Manager rotation, carried in the ciphertext envelope so a
   *  rotated key can still decrypt 7-year KYC records. */
  KYC_ENCRYPTION_KEY_ID: z.string().min(1),

  // Browser-facing origins. No wildcard, no reflection — hardening.ts allowlists these.
  ALLOWED_ORIGINS: z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().url()).min(1)),
  API_PUBLIC_ORIGIN: z.string().url(),
  COOKIE_DOMAIN: z.string().min(1),
  CSP_REPORT_URI: z.string().optional(),
  /** Ops console reaches the API only from these CIDRs (§7.2 insider controls). */
  OPS_IP_ALLOWLIST: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(1),

  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: secret(32),
  R2_BUCKET: z.string().min(1),
  PRESIGN_TTL_SECONDS: z.coerce.number().int().max(300).default(300),

  DARAJA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  DARAJA_CONSUMER_KEY: z.string().min(1),
  DARAJA_CONSUMER_SECRET: secret(16),
  DARAJA_SHORTCODE: z.string().regex(/^\d{5,9}$/),
  DARAJA_PASSKEY: secret(32),
  DARAJA_B2C_INITIATOR: z.string().min(1),
  DARAJA_B2C_CREDENTIAL: secret(32),
  DARAJA_CALLBACK_BASE: z.string().url(),
  /** Safaricom source ranges. Callbacks from anywhere else are dropped before signature
   *  verification, so a forged confirmation never reaches the money path. */
  DARAJA_SOURCE_CIDRS: z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string()).min(1)),

  ISSUER_DRIVER: z.enum(['mock', 'union']).default('mock'),
  ISSUER_BASE_URL: z.string().url().optional(),
  ISSUER_API_KEY: secret(24).optional(),
  ISSUER_WEBHOOK_SECRET: secret(32).optional(),

  AT_USERNAME: z.string().min(1),
  AT_API_KEY: secret(24),
  AT_SENDER_ID: z.string().default('SIDEQWEST'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

  // Product knobs that operations changes without a deploy would be nice, but for the MVP
  // they are config and a deploy. Do not scatter these as literals.
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(3000).default(1200), // 12%
  MIN_PAYOUT_CENTS: z.coerce.number().int().default(10000),                 // KSh 100
  CANCEL_FEE_CAP_CENTS: z.coerce.number().int().default(15000),             // KSh 150
  AUCTION_MIN_MINUTES: z.coerce.number().int().default(5),
  AUCTION_MAX_MINUTES: z.coerce.number().int().default(60),
  REIMBURSEMENT_WINDOW_MS: z.coerce.number().int().default(300_000),
  MAX_EVIDENCE_ATTEMPTS: z.coerce.number().int().default(2),
}).superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });

  if (v.NODE_ENV === 'production') {
    // The database user must be the RLS-bound role. Connecting as the owner or as a superuser
    // silently bypasses every policy in 0003_rls.sql unless FORCE RLS is set — and even with
    // FORCE, a superuser bypasses. This check is the belt to that migration's braces.
    const user = (() => { try { return new URL(v.DATABASE_URL).username; } catch { return ''; } })();
    if (!['sidequest_app', 'sidequest_worker', 'sidequest_ops'].includes(user)) {
      fail(`DATABASE_URL must connect as an RLS-bound role, not "${user || '(none)'}"`);
    }
    if (!v.DATABASE_URL.includes('sslmode=verify-full')) {
      fail('DATABASE_URL must use sslmode=verify-full in production');
    }
    if (!v.REDIS_URL.startsWith('rediss://')) {
      fail('REDIS_URL must use TLS (rediss://) in production');
    }
    if (v.ALLOWED_ORIGINS.some((o) => o.startsWith('http://') || o.includes('localhost'))) {
      fail('ALLOWED_ORIGINS contains a non-TLS or localhost origin');
    }
    if (v.OPS_IP_ALLOWLIST.length === 0) {
      fail('OPS_IP_ALLOWLIST must be set in production (§7.2)');
    }
    if (v.JWT_SECRET === v.COOKIE_SECRET || v.JWT_SECRET === v.KYC_ENCRYPTION_KEY) {
      fail('secrets must not be reused across purposes');
    }
  }

  if (v.ISSUER_DRIVER === 'union' && (!v.ISSUER_BASE_URL || !v.ISSUER_API_KEY)) {
    ctx.addIssue({ code: 'custom', message: 'ISSUER_BASE_URL and ISSUER_API_KEY are required when ISSUER_DRIVER=union' });
  }
  if (v.NODE_ENV === 'production' && v.ISSUER_DRIVER === 'mock') {
    ctx.addIssue({ code: 'custom', message: 'Refusing to boot production with the mock issuer' });
  }
  if (v.NODE_ENV === 'production' && v.DARAJA_ENV === 'sandbox') {
    ctx.addIssue({ code: 'custom', message: 'Refusing to boot production against the Daraja sandbox' });
  }
  if (v.ISSUER_DRIVER === 'union' && !v.ISSUER_WEBHOOK_SECRET) {
    ctx.addIssue({ code: 'custom', message: 'ISSUER_WEBHOOK_SECRET is required with a live issuer — an unverified card webhook can fake a load' });
  }
});

/** Field names whose values never appear in a log line, error body, or boot banner. */
const SECRET_KEYS = new Set([
  'JWT_SECRET', 'COOKIE_SECRET', 'KYC_ENCRYPTION_KEY', 'R2_SECRET_ACCESS_KEY',
  'DARAJA_CONSUMER_SECRET', 'DARAJA_PASSKEY', 'DARAJA_B2C_CREDENTIAL',
  'ISSUER_API_KEY', 'ISSUER_WEBHOOK_SECRET', 'AT_API_KEY', 'DATABASE_URL', 'REDIS_URL',
]);

/** Safe to print. Use this in the boot banner and anywhere config is attached to telemetry. */
export function redactedConfig(c: Config): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(c).map(([k, val]) => [k, SECRET_KEYS.has(k) ? '[redacted]' : val]),
  );
}

export type Config = z.infer<typeof Env>;

let cached: Config | null = null;

export function config(): Config {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(config)'}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  cached = parsed.data;

  // Make an accidental `JSON.stringify(config())` or template-literal interpolation harmless.
  // Someone will do it in a debug line at 2am during an incident; this is cheaper than
  // catching it in review.
  Object.defineProperty(cached, 'toJSON', { value: () => redactedConfig(cached!), enumerable: false });
  Object.defineProperty(cached, Symbol.for('nodejs.util.inspect.custom'), {
    value: () => redactedConfig(cached!), enumerable: false,
  });

  return cached;
}

export const isProd = () => config().NODE_ENV === 'production';
