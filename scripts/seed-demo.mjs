#!/usr/bin/env node
// Development only: builds the state the Cross-Platform Parity design shows — a Kangemi market
// run with stall 1 approved and loaded, stall 2 photographed and waiting on the requester
// (Tomatoes substituted for Roma tomatoes), and KSh 620 left of the cap — entirely through the
// real API, so the app has something true to render.
//
//   node scripts/seed-demo.mjs <path-to-api-log>
//
// OTPs are read from the API's console SMS driver output (the log path), which exists only
// with SMS_DRIVER=console. The one shortcut is promoting the demo runner to tier 3 in SQL, as
// an ops reviewer would; it needs MIGRATE_DATABASE_URL (the owner connection) from .env.

import { call, signInWith, sql, sleep, topUp } from './lib/seed-client.mjs';

const LOG = process.argv[2];
if (!LOG) { console.error('usage: node scripts/seed-demo.mjs <api-log-path>'); process.exit(2); }
const signIn = signInWith(LOG);

const amina = await signIn('0711000001', 'requester', 'Amina');
const peter0 = await signIn('0711000002', 'runner', 'Peter K');
sql(`UPDATE account SET verification_tier = 3 WHERE id = '${peter0.account.id}';
     INSERT INTO kyc_case (account_id, target_tier, status, movement_consent) VALUES ('${peter0.account.id}', 3, 'approved', true);`);
const peter = await call('POST', '/auth/refresh', null, { refresh: peter0.refresh });

await topUp(amina.access, 300_000);

const e = await call('POST', '/errands', amina.access, {
  kind: 'market_run', title: 'Kangemi Market run', notes: 'Firm tomatoes please.',
  pickup: { lat: -1.2641, lng: 36.7519, label: 'Kangemi Market' },
  dropoff: { lat: -1.2921, lng: 36.7836, label: 'Kilimani, Wood Ave 12' },
  spend_cap_cents: 100_000, max_fee_cents: 40_000, bonus_cents: 5_000,
  deadline_at: new Date(Date.now() + 2 * 3600_000).toISOString(), auction_minutes: 5, assignment_mode: 'pick',
  stalls: [
    { seq: 1, name: 'Cereals — Mzee Otieno', items: [{ label: 'Beans', qty: 2, unit: 'kg' }, { label: 'Unga', qty: 2, unit: 'kg' }] },
    { seq: 2, name: 'Mama Ngina Greens', till_number: '174379',
      items: [{ label: 'Sukuma wiki', qty: 2, unit: 'bunch' }, { label: 'Roma tomatoes', qty: 1, unit: 'kg' }, { label: 'Onions', qty: 1, unit: 'kg' }] },
    { seq: 3, name: 'Butchery — Ndege', items: [{ label: 'Beef', qty: 1, unit: 'kg' }] },
  ],
});
await call('POST', `/errands/${e.id}/publish`, amina.access);
await call('POST', `/errands/${e.id}/fund`, amina.access, { rail: 'wallet' });
await call('POST', `/errands/${e.id}/offer`, amina.access, { runner_id: peter.account.id, fee_cents: 30_000 });
await call('POST', `/errands/${e.id}/accept`, peter.access);
for (let i = 0; i < 20; i++) { await sleep(500); if ((await call('GET', `/errands/${e.id}`, amina.access)).card) break; }
await call('POST', `/errands/${e.id}/start`, peter.access);
await call('POST', `/errands/${e.id}/arrive`, peter.access);

async function photograph(stall, prices) {
  await call('POST', `/errands/${e.id}/stalls/${stall.id}/items`, peter.access, { items: stall.items.map((it, i) => ({ id: it.id, price_cents: prices[i] })) });
  const slot = await call('POST', `/errands/${e.id}/stalls/${stall.id}/evidence`, peter.access, { kind: 'goods', content_type: 'image/jpeg', taken_at: new Date().toISOString() });
  // A tiny valid JPEG so the sheet has a real image to draw.
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  await fetch(slot.upload_url, { method: 'PUT', headers: slot.headers, body: jpeg });
  await call('POST', `/errands/${e.id}/stalls/${stall.id}/submit`, peter.access);
}

await photograph(e.stalls[0], [20_000, 18_000]);
await call('POST', `/errands/${e.id}/stalls/${e.stalls[0].id}/approve`, amina.access);
await sleep(2500);
await photograph(e.stalls[1], [6_000, 20_000, 14_000]);
// Amina asked for a substitute on the tomatoes; the sheet shows it in sage.
await call('POST', `/errands/${e.id}/stalls/${e.stalls[1].id}/substitute`, amina.access,
  { line_item_id: e.stalls[1].items[1].id, label: 'Tomatoes', qty: 1, unit: 'kg', price_cents: 18_000 });

console.log(JSON.stringify({ errand: e.id, stall: e.stalls[1].id, requester: '0711000001', runner: '0711000002' }));
