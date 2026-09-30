// A fresh database per run, migrated by the real runner, and a clean Redis db. The suite then
// connects as sidequest_app / _worker / _ops — never as the owner, which would bypass every
// policy and pass regardless.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import { Redis } from 'ioredis';
import { ADMIN_URL, TEST_DB, REDIS_URL, ROLE_PASSWORD } from './env.js';

export default async function setup() {
  const root = new URL(ADMIN_URL);
  root.pathname = '/postgres';
  const admin = postgres(root.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const here = dirname(fileURLToPath(import.meta.url));
  execFileSync('npx', ['tsx', join(here, '../../packages/db/scripts/migrate.ts')], {
    env: { ...process.env, DATABASE_URL: ADMIN_URL, APP_ROLE_PASSWORD: ROLE_PASSWORD, NODE_ENV: 'test' },
    stdio: 'pipe',
  });

  const redis = new Redis(REDIS_URL);
  await redis.flushdb();
  redis.disconnect();
}
