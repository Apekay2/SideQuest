#!/usr/bin/env node
// Side Qwest — black-box acceptance suite.
//
// Drives a running build of the Side Qwest API over plain HTTP and scores it against the
// contract in PROMPT.md. It knows nothing about how the build is implemented, so the same
// script scores any build, in any language.
//
//   node acceptance.mjs --api http://localhost:3000 --otp-log /tmp/api.log
//
// Needs: Node 22+ (no dependencies), the API and the worker running in development mode
// (fake M-Pesa, console SMS), and the API's stdout captured in the --otp-log file. Run against
// a fresh Redis (`redis-cli FLUSHALL`): per-IP sign-in limits are part of what is tested.
//
// Exit code 0 when every check passes, 1 otherwise. --json prints a machine-readable report.

import { readFileSync, statSync } from 'node:fs';
import { randomUUID, randomInt } from 'node:crypto';

// ─────────────────────────────────────────────── arguments

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]]);
  return acc;
}, []));
const API = String(args.api ?? process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const OTP_LOG = args['otp-log'] ?? process.env.OTP_LOG;
const JSON_OUT = Boolean(args.json);
if (!OTP_LOG) { console.error('usage: node acceptance.mjs --api <url> --otp-log <file the API writes stdout to> [--json]'); process.exit(2); }

const LEGAL = { terms: '2026-10-01', privacy: '2026-10-01', adult: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const number = () => `07${randomInt(10_000_000, 99_999_999)}`;

// ─────────────────────────────────────────────── HTTP

async function http(method, path, { token, body, idem, headers = {} } = {}) {
  const h = { accept: 'application/json', ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (method === 'POST' && idem !== false) h['idempotency-key'] = idem ?? randomUUID();
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

/** Read the OTP the console SMS driver printed after `offset` bytes of the log. */
async function otpAfter(offset) {
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    const buf = readFileSync(OTP_LOG);
    const fresh = buf.subarray(offset).toString('utf8').split('\n').reverse();
    const line = fresh.find((l) => /code/i.test(l) && /\b\d{6}\b/.test(l));
    if (line) return /\b(\d{6})\b/.exec(line)[1];
  }
  throw new Error(`no 6-digit code appeared in ${OTP_LOG} — is SMS_DRIVER=console and stdout captured there?`);
}

async function requestOtp(msisdn) {
  const offset = statSync(OTP_LOG).size;
  const r = await http('POST', '/auth/otp', { body: { msisdn }, idem: false });
  if (r.status !== 201 && r.status !== 200) throw new Error(`/auth/otp → ${r.status} ${JSON.stringify(r.body)}`);
  return { challenge_id: r.body.challenge_id, code: await otpAfter(offset) };
}

async function signUp({ msisdn = number(), role = 'requester', name = 'Acceptance User', legal = LEGAL } = {}) {
  const { challenge_id, code } = await requestOtp(msisdn);
  const r = await http('POST', '/auth/verify', {
    body: { challenge_id, code, role, display_name: name, ...(legal ? { accept_legal: legal } : {}) }, idem: false,
  });
  return { msisdn, res: r, session: r.status === 200 ? r.body : null };
}

async function waitFor(fn, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  return null;
}

const errand = (over = {}) => ({
  kind: 'market_run', title: 'Kangemi Market run', notes: 'Sukuma from the third row',
  pickup: { lat: -1.2641, lng: 36.7519, label: 'Kangemi Market' },
  dropoff: { lat: -1.2921, lng: 36.7836, label: 'Kilimani, Wood Ave 12' },
  spend_cap_cents: 100_000, max_fee_cents: 40_000, bonus_cents: 0,
  deadline_at: new Date(Date.now() + 3 * 3600_000).toISOString(), auction_minutes: 5, assignment_mode: 'pick',
  stalls: [{ seq: 1, name: 'Mama Ngina Greens', till_number: '174379', items: [{ label: 'Sukuma wiki', qty: 2, unit: 'bunch' }] }],
  ...over,
});

// ─────────────────────────────────────────────── checks

const results = [];
let current = '';
function section(name) { current = name; }
async function check(id, title, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, section: current, title, ok: true, ms: Date.now() - t0 });
    if (!JSON_OUT) console.log(`  PASS  ${id}  ${title}`);
  } catch (e) {
    results.push({ id, section: current, title, ok: false, ms: Date.now() - t0, error: e.message });
    if (!JSON_OUT) console.log(`  FAIL  ${id}  ${title}\n          ${e.message}`);
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }
function expectStatus(r, want, what) {
  const ok = Array.isArray(want) ? want.includes(r.status) : r.status === want;
  expect(ok, `${what}: expected HTTP ${want}, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`);
}
function expectCode(r, status, code, what) {
  expectStatus(r, status, what);
  expect(r.body && r.body.code === code, `${what}: expected problem code ${code}, got ${JSON.stringify(r.body)?.slice(0, 300)}`);
}

const ctx = {};

if (!JSON_OUT) console.log(`Side Qwest acceptance — ${API}\n`);

section('Platform');
if (!JSON_OUT) console.log('Platform');
await check('P1', 'liveness and readiness report healthy', async () => {
  expectStatus(await http('GET', '/health/live'), 200, 'GET /health/live');
  const r = await http('GET', '/health/ready');
  expectStatus(r, 200, 'GET /health/ready');
  expect(r.body?.ok === true, `ready body: ${JSON.stringify(r.body)}`);
});
await check('P2', 'errors are RFC 7807 problem+json with a machine code', async () => {
  const r = await http('GET', '/me');
  expectCode(r, 401, 'UNAUTHENTICATED', 'GET /me without a token');
  expect(String(r.headers.get('content-type')).includes('application/problem+json'), `content-type: ${r.headers.get('content-type')}`);
  expect(r.body.status === 401 && typeof r.body.title === 'string', 'problem body needs status and title');
});
await check('P3', 'security headers present; no framework fingerprint; no-store', async () => {
  const r = await http('GET', '/me');
  expect(r.headers.get('x-content-type-options') === 'nosniff', 'missing X-Content-Type-Options: nosniff');
  expect(r.headers.get('x-frame-options') === 'DENY' || /frame-ancestors 'none'/.test(r.headers.get('content-security-policy') ?? ''), 'framing not denied');
  expect(!r.headers.get('x-powered-by'), 'X-Powered-By leaks the framework');
  expect(/no-store/.test(r.headers.get('cache-control') ?? ''), 'authenticated API responses must be Cache-Control: no-store');
});
await check('P4', 'CORS does not reflect an unlisted origin', async () => {
  const r = await http('GET', '/health/live', { headers: { origin: 'https://evil.example' } });
  const acao = r.headers.get('access-control-allow-origin');
  expect(acao !== '*' && acao !== 'https://evil.example', `Access-Control-Allow-Origin: ${acao}`);
});

section('Sign-in and sessions');
if (!JSON_OUT) console.log('\nSign-in and sessions');
await check('A1', 'no account is created without accepting the terms (18+)', async () => {
  const { res } = await signUp({ legal: null });
  expectCode(res, 400, 'LEGAL_ACCEPTANCE_REQUIRED', 'verify without accept_legal');
  const { res: minor } = await signUp({ legal: { ...LEGAL, adult: false } });
  expectCode(minor, 400, 'LEGAL_ACCEPTANCE_REQUIRED', 'verify with adult:false');
  const { res: old } = await signUp({ legal: { ...LEGAL, terms: '2020-01-01' } });
  expectCode(old, 400, 'LEGAL_ACCEPTANCE_REQUIRED', 'verify with an outdated terms version');
});
await check('A2', 'OTP sign-up returns a session and a tier-1 account', async () => {
  const a = await signUp({ name: 'Amina Wanjiru' });
  expectStatus(a.res, 200, 'POST /auth/verify');
  const s = a.session;
  expect(typeof s.access === 'string' && typeof s.refresh === 'string', 'session needs access and refresh');
  expect(s.expires_in > 0 && s.expires_in <= 900, `access token must live at most 15 minutes, got ${s.expires_in}`);
  expect(s.account.role === 'requester' && s.account.verification_tier === 1, `account: ${JSON.stringify(s.account)}`);
  expect(s.account.legal_current === true, 'legal_current should be true after accepting');
  expect(s.account.entitlements.includes('errand.post') && s.account.entitlements.includes('wallet.topup'), 'tier 1 needs errand.post and wallet.topup');
  expect(!s.account.entitlements.includes('errand.accept'), 'tier 1 must not have errand.accept');
  ctx.amina = a;
});
await check('A3', 'a wrong code fails; three wrong codes burn the challenge', async () => {
  const msisdn = number();
  const { challenge_id, code } = await requestOtp(msisdn);
  const wrong = code === '000000' ? '111111' : '000000';
  const r1 = await http('POST', '/auth/verify', { body: { challenge_id, code: wrong, accept_legal: LEGAL }, idem: false });
  expectCode(r1, 400, 'OTP_INVALID', 'wrong code');
  await http('POST', '/auth/verify', { body: { challenge_id, code: wrong, accept_legal: LEGAL }, idem: false });
  await http('POST', '/auth/verify', { body: { challenge_id, code: wrong, accept_legal: LEGAL }, idem: false });
  const r4 = await http('POST', '/auth/verify', { body: { challenge_id, code, accept_legal: LEGAL }, idem: false });
  expect(r4.status !== 200, 'the right code must not work after three wrong attempts');
});
await check('A4', 'GET /me and PATCH /me', async () => {
  const t = ctx.amina.session.access;
  const me = await http('GET', '/me', { token: t });
  expectStatus(me, 200, 'GET /me');
  expect(me.body.id === ctx.amina.session.account.id, 'GET /me returns the caller');
  const p = await http('PATCH', '/me', { token: t, body: { language: 'sw' } });
  expectStatus(p, 200, 'PATCH /me');
  expect(p.body.language === 'sw', 'language was not updated');
  expectCode(await http('PATCH', '/me', { token: t, body: {} }), 400, 'VALIDATION', 'PATCH /me with nothing to update');
});
await check('A5', 'refresh rotates; reusing a spent refresh token revokes the whole family', async () => {
  const s = (await signUp({ name: 'Rotating Rose' })).session;
  const r1 = await http('POST', '/auth/refresh', { body: { refresh: s.refresh }, idem: false });
  expectStatus(r1, 200, 'first refresh');
  expect(r1.body.refresh !== s.refresh, 'refresh token must rotate');
  const reuse = await http('POST', '/auth/refresh', { body: { refresh: s.refresh }, idem: false });
  expectStatus(reuse, 401, 'reusing the spent refresh token');
  const after = await http('POST', '/auth/refresh', { body: { refresh: r1.body.refresh }, idem: false });
  expectStatus(after, 401, 'the newest token after reuse was detected');
});
await check('A6', 'logout revokes the refresh token', async () => {
  const s = (await signUp({ name: 'Leaving Lucy' })).session;
  expectStatus(await http('POST', '/auth/logout', { token: s.access, body: { refresh: s.refresh }, idem: false }), [200, 204], 'POST /auth/logout');
  expectStatus(await http('POST', '/auth/refresh', { body: { refresh: s.refresh }, idem: false }), 401, 'refresh after logout');
});
await check('A7', 'OTP requests are rate limited per number (5/hour)', async () => {
  const msisdn = number();
  let limited = null;
  for (let i = 0; i < 7 && !limited; i++) {
    const r = await http('POST', '/auth/otp', { body: { msisdn }, idem: false });
    if (r.status === 429) limited = r;
  }
  expect(limited, 'no 429 after 7 OTP requests for one number');
  expect(limited.body?.code === 'RATE_LIMITED', `429 body code: ${JSON.stringify(limited.body)}`);
});

section('Errands');
if (!JSON_OUT) console.log('\nErrands');
await check('E1', 'creating an errand returns a draft with its deposit', async () => {
  const r = await http('POST', '/errands', { token: ctx.amina.session.access, body: errand() });
  expectStatus(r, 201, 'POST /errands');
  expect(r.body.status === 'draft', `status ${r.body.status}`);
  expect(Number.isInteger(r.body.deposit_cents) && r.body.deposit_cents >= 140_000, `deposit_cents ${r.body.deposit_cents}`);
  expect(r.body.stalls?.length === 1 && r.body.stalls[0].items?.length === 1, 'stalls and items are returned');
  ctx.errand = r.body;
});
await check('E2', 'deposit = fee + goods cap + bonus + requester half of a 12% fee', async () => {
  const e = ctx.errand;
  // 12% of KES 400 = KES 48; the requester's half is KES 24, charged on top.
  expect(e.deposit_cents === 40_000 + 100_000 + 0 + 2_400, `deposit_cents ${e.deposit_cents}, expected 142400`);
});
await check('E3', 'invalid bodies are rejected with VALIDATION', async () => {
  const r = await http('POST', '/errands', { token: ctx.amina.session.access, body: errand({ spend_cap_cents: -5 }) });
  expectCode(r, 400, 'VALIDATION', 'negative spend cap');
  const r2 = await http('POST', '/errands', { token: ctx.amina.session.access, body: errand({ dropoff: undefined }) });
  expectCode(r2, 400, 'VALIDATION', 'missing dropoff');
});
await check('E4', 'another person cannot see my errand (404, not 403)', async () => {
  ctx.otto = await signUp({ name: 'Other Otto' });
  const r = await http('GET', `/errands/${ctx.errand.id}`, { token: ctx.otto.session.access });
  expectStatus(r, 404, 'GET /errands/:id as a stranger');
});
await check('E5', 'a tier-1 requester cannot use runner or staff endpoints', async () => {
  const t = ctx.otto.session.access;
  expectStatus(await http('POST', `/errands/${ctx.errand.id}/accept`, { token: t }), [403, 404], 'accept as tier 1');
  expectStatus(await http('GET', '/ops/overview', { token: t }), [403, 404], 'GET /ops/overview as a customer');
});

section('Money');
if (!JSON_OUT) console.log('\nMoney');
await check('M1', 'top-up is accepted (202) and credited only after the rail calls back', async () => {
  const t = ctx.amina.session.access;
  const w0 = await http('GET', '/wallet', { token: t });
  expectStatus(w0, 200, 'GET /wallet');
  expect(w0.body.balance_cents === 0 && w0.body.currency === 'KES', `new wallet: ${JSON.stringify(w0.body)}`);
  const r = await http('POST', '/wallet/topup', { token: t, body: { amount_cents: 300_000 } });
  expectStatus(r, 202, 'POST /wallet/topup');
  expect(r.body.status === 'initiated', `status ${r.body.status}`);
  const credited = await waitFor(async () => (await http('GET', '/wallet', { token: t })).body.balance_cents === 300_000);
  expect(credited, 'wallet not credited with 300000 within 30s — is the worker running with the fake rail?');
});
await check('M2', 'M-Pesa amounts must be whole shillings', async () => {
  const r = await http('POST', '/wallet/topup', { token: ctx.amina.session.access, body: { amount_cents: 10_050 } });
  expectCode(r, 400, 'VALIDATION', 'top-up of KES 100.50');
});
await check('M3', 'idempotency: same key replays, same key with a new body conflicts, no key is refused', async () => {
  const t = ctx.amina.session.access;
  const key = randomUUID();
  const a = await http('POST', '/wallet/topup', { token: t, body: { amount_cents: 1_000 }, idem: key });
  const b = await http('POST', '/wallet/topup', { token: t, body: { amount_cents: 1_000 }, idem: key });
  expectStatus(a, 202, 'first request');
  expectStatus(b, 202, 'replay');
  expect(a.body.payment_id === b.body.payment_id, 'a replay must return the original response, not create a second payment');
  const c = await http('POST', '/wallet/topup', { token: t, body: { amount_cents: 2_000 }, idem: key });
  expectCode(c, 409, 'IDEMPOTENCY_CONFLICT', 'same key, different body');
  const d = await http('POST', '/wallet/topup', { token: t, body: { amount_cents: 1_000 }, idem: false });
  expectStatus(d, 400, 'no Idempotency-Key on a money route');
  await waitFor(async () => (await http('GET', '/wallet', { token: t })).body.balance_cents === 301_000);
});
await check('M4', 'publish then fund from the wallet: errand opens, deposit moves into escrow', async () => {
  const t = ctx.amina.session.access;
  const id = ctx.errand.id;
  const before = (await http('GET', '/wallet', { token: t })).body.balance_cents;
  const p = await http('POST', `/errands/${id}/publish`, { token: t });
  expectStatus(p, [200, 201], 'publish');
  const f = await http('POST', `/errands/${id}/fund`, { token: t, body: { rail: 'wallet' } });
  expectStatus(f, 200, 'fund from wallet');
  const e = await http('GET', `/errands/${id}`, { token: t });
  expect(e.body.status === 'open', `status after funding: ${e.body.status}`);
  const w = (await http('GET', '/wallet', { token: t })).body;
  expect(w.balance_cents === before - ctx.errand.deposit_cents, `wallet ${w.balance_cents}, expected ${before - ctx.errand.deposit_cents}`);
  const held = w.escrow.find((x) => x.errand_id === id);
  expect(held && held.held_cents > 0, `escrow lines: ${JSON.stringify(w.escrow)}`);
});
await check('M5', 'funding more than the wallet holds is refused', async () => {
  const t = ctx.otto.session.access;
  const e = await http('POST', '/errands', { token: t, body: errand() });
  await http('POST', `/errands/${e.body.id}/publish`, { token: t });
  const f = await http('POST', `/errands/${e.body.id}/fund`, { token: t, body: { rail: 'wallet' } });
  expectCode(f, 409, 'INSUFFICIENT_FUNDS', 'fund with an empty wallet');
});
await check('M6', 'cancelling a funded, unassigned errand refunds the whole deposit', async () => {
  const t = ctx.amina.session.access;
  const before = (await http('GET', '/wallet', { token: t })).body.balance_cents;
  const c = await http('POST', `/errands/${ctx.errand.id}/cancel`, { token: t, body: { reason: 'Changed my mind' } });
  expectStatus(c, [200, 202], 'cancel');
  const refunded = await waitFor(async () => (await http('GET', '/wallet', { token: t })).body.balance_cents === before + ctx.errand.deposit_cents);
  expect(refunded, 'deposit not returned to the wallet within 30s');
  const e = await http('GET', `/errands/${ctx.errand.id}`, { token: t });
  expect(e.body.status === 'cancelled', `status ${e.body.status}`);
});
await check('M7', 'withdrawing more than the balance is refused', async () => {
  const r = await http('POST', '/wallet/withdraw', { token: ctx.otto.session.access, body: { amount_cents: 10_000 } });
  expectStatus(r, [403, 409], 'withdraw from an empty wallet');
});

section('Privacy and legal');
if (!JSON_OUT) console.log('\nPrivacy and legal');
await check('L1', 'a copy of my data, as a download, with nothing about anyone else', async () => {
  const r = await http('GET', '/me/export', { token: ctx.amina.session.access });
  expectStatus(r, 200, 'GET /me/export');
  expect(/attachment/.test(r.headers.get('content-disposition') ?? ''), 'export should be Content-Disposition: attachment');
  expect(r.body.account?.id === ctx.amina.session.account.id, 'export.account is the caller');
  expect(r.body.account?.msisdn === `+254${ctx.amina.msisdn.slice(1)}`, `export.account.msisdn ${r.body.account?.msisdn}`);
  expect(Array.isArray(r.body.legal_acceptances) && r.body.legal_acceptances.length >= 2, 'acceptances of terms and privacy are included');
  expect(Array.isArray(r.body.payments) && r.body.payments.length >= 1, 'payments are included');
  expect(!JSON.stringify(r.body).includes(ctx.otto.session.account.id), 'export leaks another account');
});
await check('L2', 'deleting needs explicit confirmation, and is refused while money is held', async () => {
  const t = ctx.amina.session.access;
  expectStatus(await http('POST', '/me/delete', { token: t, body: {} }), 400, 'delete without confirm');
  const r = await http('POST', '/me/delete', { token: t, body: { confirm: 'DELETE' } });
  expectCode(r, 409, 'ACCOUNT_HAS_BALANCE', 'delete with a wallet balance');
});
await check('L3', 'deleting an account ends its sessions and frees the number', async () => {
  const gone = await signUp({ name: 'Erased Ezra' });
  const r = await http('POST', '/me/delete', { token: gone.session.access, body: { confirm: 'DELETE' } });
  expectStatus(r, 204, 'POST /me/delete');
  expectStatus(await http('POST', '/auth/refresh', { body: { refresh: gone.session.refresh }, idem: false }), 401, 'refresh after deletion');
  const again = await signUp({ msisdn: gone.msisdn, name: 'Fresh Start' });
  expectStatus(again.res, 200, 'sign up again with the same number');
  expect(again.session.account.id !== gone.session.account.id, 'the number must start a new account');
});
await check('L4', 'location consent is only for verified runners', async () => {
  const t = ctx.otto.session.access;
  const g = await http('GET', '/me/location-consent', { token: t });
  expectStatus(g, 200, 'GET /me/location-consent');
  expect(g.body.consent === null, `consent ${JSON.stringify(g.body)}`);
  expectCode(await http('POST', '/me/location-consent', { token: t, body: { consent: true } }), 409, 'TIER_REQUIRED', 'consent without tier 3');
});

// ─────────────────────────────────────────────── report

const passed = results.filter((r) => r.ok).length;
const report = { api: API, passed, total: results.length, score: `${passed}/${results.length}`, results };
if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`\n${passed}/${results.length} checks passed`);
  const bySection = {};
  for (const r of results) (bySection[r.section] ??= [0, 0])[r.ok ? 0 : 1]++;
  for (const [s, [ok, bad]] of Object.entries(bySection)) console.log(`  ${s.padEnd(22)} ${ok}/${ok + bad}`);
}
process.exit(passed === results.length ? 0 : 1);
