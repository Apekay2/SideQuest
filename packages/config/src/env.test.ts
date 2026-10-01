// Production must refuse to boot on anything that would silently weaken it. Each refusal is
// a line in env.ts a refactor could delete; each test here is what notices.

import { describe, test, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig, looksLikePlaceholder } from './env.js';

const s = (n = 48) => randomBytes(n).toString('base64url');

function prodEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://sidequest_app:x@db.internal:5432/sq?sslmode=verify-full',
    OPS_DATABASE_URL: 'postgres://sidequest_ops:x@db.internal:5432/sq?sslmode=verify-full',
    REDIS_URL: 'rediss://cache.internal:6379',
    JWT_SECRET: s(), COOKIE_SECRET: s(), KYC_ENCRYPTION_KEY: s(), KYC_ENCRYPTION_KEY_ID: 'kms-2026-09',
    HANDOVER_SECRET: s(),
    ALLOWED_ORIGINS: 'https://console.sidequest.co.ke',
    API_PUBLIC_ORIGIN: 'https://api.sidequest.co.ke',
    COOKIE_DOMAIN: 'sidequest.co.ke',
    OPS_IP_ALLOWLIST: '10.0.0.0/16',
    STORAGE_DRIVER: 'r2', R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'akid', R2_SECRET_ACCESS_KEY: s(), R2_BUCKET: 'evidence',
    DARAJA_DRIVER: 'daraja', DARAJA_ENV: 'production', DARAJA_CONSUMER_KEY: 'ck', DARAJA_CONSUMER_SECRET: s(),
    DARAJA_SHORTCODE: '174379', DARAJA_PASSKEY: s(), DARAJA_B2C_INITIATOR: 'sq-initiator',
    DARAJA_B2C_CREDENTIAL: s(), DARAJA_CALLBACK_BASE: 'https://api.sidequest.co.ke', DARAJA_CALLBACK_TOKEN: s(), PUSH_DRIVER: 'expo',
    DARAJA_SOURCE_CIDRS: '196.201.214.0/24',
    ISSUER_DRIVER: 'union', ISSUER_BASE_URL: 'https://issuer.example-bank.co.ke', ISSUER_API_KEY: s(32),
    ISSUER_WEBHOOK_SECRET: s(),
    SMS_DRIVER: 'africastalking', AT_USERNAME: 'sidequest', AT_API_KEY: s(32),
  };
}

describe('config refusals', () => {
  test('a complete production environment boots', () => {
    expect(() => loadConfig(prodEnv())).not.toThrow();
  });

  test.each([
    ['placeholder JWT_SECRET', { JWT_SECRET: 'changeme_changeme_changeme_changeme_changeme_ab' }],
    ['low-entropy JWT_SECRET', { JWT_SECRET: 'ab'.repeat(30) }],
    ['owner DATABASE_URL', { DATABASE_URL: 'postgres://sidequest_migrator@db/sq?sslmode=verify-full' }],
    ['no TLS to the database', { DATABASE_URL: 'postgres://sidequest_app:x@db/sq' }],
    ['plaintext Redis', { REDIS_URL: 'redis://cache:6379' }],
    ['plaintext origin', { ALLOWED_ORIGINS: 'http://console.sidequest.co.ke' }],
    ['empty ops allowlist', { OPS_IP_ALLOWLIST: '' }],
    ['sandbox rails', { DARAJA_ENV: 'sandbox' }],
    ['mock issuer', { ISSUER_DRIVER: 'mock' }],
    ['fake M-Pesa driver', { DARAJA_DRIVER: 'fake' }],
    ['console push driver', { PUSH_DRIVER: 'console' }],
    ['local storage', { STORAGE_DRIVER: 'local' }],
    ['console SMS', { SMS_DRIVER: 'console' }],
    ['ops pool as the app role', { OPS_DATABASE_URL: 'postgres://sidequest_app:x@db/sq?sslmode=verify-full' }],
  ])('production refuses to boot with %s', (_label, override) => {
    expect(() => loadConfig({ ...prodEnv(), ...override })).toThrow();
  });

  test('a reused secret is refused', () => {
    const env = prodEnv();
    expect(() => loadConfig({ ...env, COOKIE_SECRET: env.JWT_SECRET! })).toThrow(/reused/);
  });

  test('a live rail with missing credentials is refused in any environment', () => {
    const env = { ...prodEnv(), NODE_ENV: 'development' };
    delete (env as Record<string, string | undefined>).DARAJA_PASSKEY;
    expect(() => loadConfig(env)).toThrow(/DARAJA_PASSKEY/);
    const noToken = { ...prodEnv() };
    delete (noToken as Record<string, string | undefined>).DARAJA_CALLBACK_TOKEN;
    expect(() => loadConfig(noToken)).toThrow(/DARAJA_CALLBACK_TOKEN/);
  });

  test('config never prints a secret', () => {
    const env = prodEnv();
    const printed = JSON.stringify(loadConfig(env));
    expect(printed).toMatch(/\[redacted\]/);
    for (const k of ['JWT_SECRET', 'DARAJA_PASSKEY', 'HANDOVER_SECRET', 'DATABASE_URL'] as const) {
      expect(printed).not.toContain(env[k]);
    }
  });
});

describe('app-review sign-in', () => {
  const base = () => ({ ...prodEnv(), REVIEW_LOGIN_MSISDN: '+254700000123' });
  test('number and code go together, and the code cannot be trivial', () => {
    expect(() => loadConfig(base())).toThrow(/go together/);
    expect(() => loadConfig({ ...base(), REVIEW_LOGIN_CODE: '111111' })).toThrow(/non-trivial/);
    expect(() => loadConfig({ ...base(), REVIEW_LOGIN_CODE: '120120' })).toThrow(/non-trivial/);
    expect(loadConfig({ ...base(), REVIEW_LOGIN_CODE: '482915' }).REVIEW_LOGIN_MSISDN).toBe('+254700000123');
  });
});

describe('placeholder detection', () => {
  test('obvious placeholders are refused, in any case or with decoration', () => {
    for (const v of ['CHANGEME', 'changeme123', 'my_secret_key_2024', 'Password!', 'sk_test_51abc', 'your-key-here', 'xxx-xxx', 'TODO']) {
      expect(looksLikePlaceholder(v), v).toBe(true);
    }
  });

  test('freshly generated secrets are never refused (this used to fail at random)', () => {
    // 20 000 base64/base64url secrets, the shapes `openssl rand -base64 48` and dev-env produce.
    const refused: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      for (const v of [randomBytes(48).toString('base64'), randomBytes(48).toString('base64url')]) {
        if (looksLikePlaceholder(v)) refused.push(v);
      }
    }
    expect(refused).toEqual([]);
  });
});
