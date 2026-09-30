#!/usr/bin/env node
// Writes a local .env for development with freshly generated secrets. Every secret passes the
// same entropy and placeholder checks production does (packages/config/src/env.ts): there is
// no "dev secret" that would be refused in production, only dev DRIVERS that are.
//
//   node scripts/dev-env.mjs            write .env if it does not exist
//   node scripts/dev-env.mjs --force    overwrite

import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const out = new URL('../.env', import.meta.url);
if (existsSync(out) && !process.argv.includes('--force')) {
  console.log('.env exists; pass --force to regenerate');
  process.exit(0);
}
const s = (n = 48) => randomBytes(n).toString('base64url');
const pg = process.env.PGHOST ?? 'localhost';
const pw = process.env.APP_ROLE_PASSWORD ?? s(18);

const env = {
  NODE_ENV: 'development',
  PORT: '3000',
  LOG_LEVEL: 'info',
  // Migrations run as the owner; the API and worker never do.
  MIGRATE_DATABASE_URL: `postgres://postgres:${process.env.PGPASSWORD ?? 'devpass'}@${pg}:5432/sq_dev`,
  APP_ROLE_PASSWORD: pw,
  DATABASE_URL: `postgres://sidequest_app:${pw}@${pg}:5432/sq_dev`,
  OPS_DATABASE_URL: `postgres://sidequest_ops:${pw}@${pg}:5432/sq_dev`,
  WORKER_DATABASE_URL: `postgres://sidequest_worker:${pw}@${pg}:5432/sq_dev`,
  REDIS_URL: `redis://${process.env.REDIS_HOST ?? 'localhost'}:6379`,
  JWT_SECRET: s(), COOKIE_SECRET: s(), KYC_ENCRYPTION_KEY: s(), KYC_ENCRYPTION_KEY_ID: 'dev-1',
  HANDOVER_SECRET: s(),
  ALLOWED_ORIGINS: 'http://localhost:3001,http://localhost:8081',
  API_PUBLIC_ORIGIN: 'http://localhost:3000',
  COOKIE_DOMAIN: 'localhost',
  TRUSTED_PROXY_HOPS: '0',
  STORAGE_DRIVER: 'local',
  DARAJA_DRIVER: 'fake',
  SMS_DRIVER: 'console',
  ISSUER_DRIVER: 'mock',
};
writeFileSync(out, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
console.log('wrote .env (secrets generated; drivers: local storage, fake M-Pesa, console SMS, mock issuer)');
