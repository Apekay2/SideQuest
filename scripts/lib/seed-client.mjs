// Shared by the development seed scripts: an API client that signs in with OTPs read from the
// console SMS driver's log, and an owner-connection psql for the few steps an administrator
// would do by hand (promoting a runner, granting staff entitlements).

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';

export const API = process.env.API_URL ?? 'http://localhost:3000';
export const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The seeds write as the database owner, so being on development drivers is not proof enough:
// they also refuse to run unless both the env file and the target API are local.
const isLocal = (u) => { try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(u).hostname); } catch { return false; } };
if (env.NODE_ENV !== 'development' || env.SMS_DRIVER !== 'console' || !isLocal(API) || !isLocal(env.MIGRATE_DATABASE_URL ?? '')) {
  console.error('seed refused: requires NODE_ENV=development, SMS_DRIVER=console, and a localhost API and database');
  process.exit(2);
}

export async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return json;
}

export function signInWith(logPath) {
  return async function signIn(msisdn, role, name) {
    const { challenge_id } = await call('POST', '/auth/otp', null, { msisdn });
    await sleep(300);
    const tail = readFileSync(logPath, 'utf8').split('\n').reverse().find((l) => l.includes(`…${msisdn.slice(-3)}`) && /code is \d{6}/.test(l));
    const code = /code is (\d{6})/.exec(tail ?? '')?.[1];
    if (!code) throw new Error('OTP not found in the API log — is SMS_DRIVER=console?');
    return call('POST', '/auth/verify', null, { challenge_id, code, role, display_name: name });
  };
}

export function sql(q) {
  execFileSync('psql', [env.MIGRATE_DATABASE_URL, '-q', '-v', 'ON_ERROR_STOP=1', '-c', q], { stdio: 'pipe' });
}

/** Wait for the worker to credit a top-up (the fake Daraja callback travels through the outbox). */
export async function topUp(token, cents) {
  const before = (await call('GET', '/wallet', token)).balance_cents;
  await call('POST', '/wallet/topup', token, { amount_cents: cents });
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if ((await call('GET', '/wallet', token)).balance_cents >= before + cents) return;
  }
  throw new Error('top-up never credited — is the worker running?');
}

/** A plain solid-colour PNG, so seeded photos are visibly placeholders and never look real. */
export function placeholderPng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function put(slot, bytes) {
  const res = await fetch(slot.upload_url, { method: 'PUT', headers: slot.headers, body: bytes });
  if (!res.ok) throw new Error(`upload → ${res.status}`);
}
