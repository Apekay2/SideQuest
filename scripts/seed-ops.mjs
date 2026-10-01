#!/usr/bin/env node
// Development only: gives the ops console something true to show, entirely through the real
// API — a staff officer, a runner's tier-3 KYC case waiting for review, and a market run that
// went to a dispute with photos and messages on it.
//
//   node scripts/seed-ops.mjs <path-to-api-log>
//
// The officer (0711000009) is promoted and granted every staff entitlement in SQL, as the
// system administrator would. Sign in to the console with that number; the OTP is in the API log.
// Images are solid-colour placeholders.

import { call, signInWith, sql, sleep, topUp, placeholderPng, put } from './lib/seed-client.mjs';

const LOG = process.argv[2];
if (!LOG) { console.error('usage: node scripts/seed-ops.mjs <api-log-path>'); process.exit(2); }
const signIn = signInWith(LOG);
const SAND = [235, 221, 197], SAGE = [122, 138, 94], CLAY = [198, 113, 57];

// ── the officer
const officer = await signIn('0711000009', 'requester', 'L. Mutiso');
sql(`UPDATE account SET role = 'staff',
       staff_grants = ARRAY['ops.read','kyc.review','evidence.view','ledger.read','location.read_cells','audit.read','legal_ops','accounts.manage','staff.admin']
     WHERE id = '${officer.account.id}'`);

// ── a KYC case: a runner asking for tier 3
const wanjiku = await signIn('0711000003', 'runner', 'Wanjiku M');
const kyc = await call('POST', '/kyc/cases', wanjiku.access, { target_tier: 3 });
for (const [slot, colour] of [['id_front', SAND], ['id_back', SAND], ['selfie', SAGE], ['conduct_cert', CLAY]]) {
  const target = await call('POST', `/kyc/cases/${kyc.id}/documents`, wanjiku.access, { slot, content_type: 'image/png' });
  await put(target, placeholderPng(480, 300, colour));
}
await call('POST', `/kyc/cases/${kyc.id}/submit`, wanjiku.access, {
  id_number: '28471936', next_of_kin: { name: 'Joseph M', msisdn: '0722000123' }, movement_consent: true,
});

// ── a dispute: Otieno's run with Grace stalls after the first stall
const otieno = await signIn('0711000004', 'requester', 'Otieno');
const grace0 = await signIn('0711000005', 'runner', 'Grace W');
sql(`UPDATE account SET verification_tier = 3 WHERE id = '${grace0.account.id}';
     INSERT INTO kyc_case (account_id, target_tier, status, movement_consent) VALUES ('${grace0.account.id}', 3, 'approved', true);`);
const grace = await call('POST', '/auth/refresh', null, { refresh: grace0.refresh });
await topUp(otieno.access, 300_000);

const e = await call('POST', '/errands', otieno.access, {
  kind: 'market_run', title: 'Toi Market run', notes: 'Ripe but firm, please.',
  pickup: { lat: -1.3031, lng: 36.7870, label: 'Toi Market' },
  dropoff: { lat: -1.2990, lng: 36.7650, label: 'Lavington, James Gichuru Rd' },
  spend_cap_cents: 120_000, max_fee_cents: 40_000, bonus_cents: 0,
  deadline_at: new Date(Date.now() + 2 * 3600_000).toISOString(), auction_minutes: 5, assignment_mode: 'pick',
  stalls: [
    { seq: 1, name: 'Mama Akinyi Fruits', items: [{ label: 'Tomatoes', qty: 1, unit: 'kg' }, { label: 'Avocados', qty: 4, unit: 'pc' }] },
    { seq: 2, name: 'Toi Dry Goods', items: [{ label: 'Rice', qty: 2, unit: 'kg' }] },
  ],
});
await call('POST', `/errands/${e.id}/publish`, otieno.access);
await call('POST', `/errands/${e.id}/fund`, otieno.access, { rail: 'wallet' });
await call('POST', `/errands/${e.id}/offer`, otieno.access, { runner_id: grace.account.id, fee_cents: 25_000 });
await call('POST', `/errands/${e.id}/accept`, grace.access);
for (let i = 0; i < 20; i++) { await sleep(500); if ((await call('GET', `/errands/${e.id}`, otieno.access)).card) break; }
await call('POST', `/errands/${e.id}/start`, grace.access);
await call('POST', `/errands/${e.id}/arrive`, grace.access);

const stall = e.stalls[0];
await call('POST', `/errands/${e.id}/stalls/${stall.id}/items`, grace.access, { items: stall.items.map((it, i) => ({ id: it.id, price_cents: [16_000, 24_000][i] })) });
for (const colour of [SAGE, CLAY]) {
  const slot = await call('POST', `/errands/${e.id}/stalls/${stall.id}/evidence`, grace.access, { kind: 'goods', content_type: 'image/png', taken_at: new Date().toISOString() });
  await put(slot, placeholderPng(400, 300, colour));
}
await call('POST', `/errands/${e.id}/stalls/${stall.id}/submit`, grace.access);
await call('POST', `/errands/${e.id}/messages`, otieno.access, { body: 'KSh 160 for a kilo of tomatoes? The morning price at Toi is closer to 100.' });
await call('POST', `/errands/${e.id}/messages`, grace.access, { body: 'That was the only lot left at that stall, and the price she gave.' });

const d = await call('POST', '/disputes', otieno.access, {
  errand_id: e.id, reason: 'overcharged', detail: 'Tomatoes billed well above the market price and the photo shows a smaller lot than a kilo.',
});
await sleep(2500);   // the worker freezes escrow and voids the card

console.log(JSON.stringify({ officer: '0711000009', kyc_case: kyc.id, dispute: d.id, errand: e.id }));
