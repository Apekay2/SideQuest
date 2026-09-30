// Test environment. Secrets are generated per run and pass the same checks production does.

import { randomBytes } from 'node:crypto';

const host = process.env.PGHOST ?? 'localhost';
export const TEST_DB = process.env.TEST_DB ?? 'sq_test';
export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL
  ?? `postgres://postgres:${process.env.PGPASSWORD ?? 'devpass'}@${host}:5432/${TEST_DB}`;
export const ROLE_PASSWORD = process.env.APP_ROLE_PASSWORD ?? 'e2e-role-pw';
export const REDIS_URL = process.env.TEST_REDIS_URL ?? `redis://${process.env.REDIS_HOST ?? 'localhost'}:6379/15`;

const s = () => randomBytes(48).toString('base64url');
const role = (r: string) => `postgres://${r}:${ROLE_PASSWORD}@${host}:5432/${TEST_DB}`;

export function testEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: role('sidequest_app'),
    OPS_DATABASE_URL: role('sidequest_ops'),
    WORKER_DATABASE_URL: role('sidequest_worker'),
    REDIS_URL,
    JWT_SECRET: s(), COOKIE_SECRET: s(), KYC_ENCRYPTION_KEY: s(), KYC_ENCRYPTION_KEY_ID: 'test-1',
    HANDOVER_SECRET: s(),
    ALLOWED_ORIGINS: 'https://console.sidequest.test',
    API_PUBLIC_ORIGIN: 'http://api.sidequest.test',
    COOKIE_DOMAIN: 'sidequest.test',
    TRUSTED_PROXY_HOPS: '0',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: `/tmp/sq-e2e-uploads-${process.pid}`,
    DARAJA_DRIVER: 'fake',
    SMS_DRIVER: 'console',
    ISSUER_DRIVER: 'mock',
  };
}
