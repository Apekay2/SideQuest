#!/usr/bin/env node
// Bootstraps the first staff admin — the one account the console cannot create, because
// creating staff needs a staff admin. Run once per environment, as the database owner:
//
//   MIGRATE_DATABASE_URL=postgres://owner@host/db node scripts/create-admin.mjs 0712345678 "Jane Wanjiru"
//
// After this, everything else (more staff, their access) is done from the console's Users page,
// and audited there. This script refuses to touch an existing customer account: staff numbers
// are dedicated, and a customer's history must not become an operator's.

import { execFileSync } from 'node:child_process';

const [raw, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(' ').trim();
const url = process.env.MIGRATE_DATABASE_URL;
if (!raw || !name || !url) {
  console.error('usage: MIGRATE_DATABASE_URL=… node scripts/create-admin.mjs <07… number> "<display name>"');
  process.exit(2);
}
const m = /^(?:\+?254|0)(7\d{8}|1\d{8})$/.exec(raw.replace(/[\s\-()]/g, ''));
if (!m) { console.error('Enter a Kenyan mobile number'); process.exit(2); }
if (!/^[\p{L} .'-]{2,48}$/u.test(name)) { console.error('Display name: 2–48 letters'); process.exit(2); }
const msisdn = `+254${m[1]}`;

const GRANTS = ['ops.read', 'kyc.review', 'evidence.view', 'ledger.read', 'location.read_cells', 'audit.read', 'legal_ops', 'accounts.manage', 'staff.admin'];
// psql variables (:'x') are quoted literals, so nothing from argv is spliced into SQL.
const psql = (sql, out = 'inherit') => execFileSync('psql', [url, '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', `msisdn=${msisdn}`,
  '-v', `name=${name}`, '-v', `grants={${GRANTS.join(',')}}`], { input: sql, stdio: ['pipe', out, 'inherit'] });

try {
  const existing = String(psql(`SELECT role FROM account WHERE msisdn = :'msisdn';`, 'pipe') ?? '').trim();
  if (existing && existing !== 'staff') {
    console.error(`That number belongs to a ${existing} account. Use a dedicated number for staff.`);
    process.exit(1);
  }
  psql(`
    INSERT INTO account (msisdn, display_name, role, verification_tier, language, market, staff_grants)
    VALUES (:'msisdn', :'name', 'staff', 1, 'en', 'KE', :'grants'::text[])
    ON CONFLICT (msisdn) DO UPDATE SET staff_grants = EXCLUDED.staff_grants, suspended_at = NULL, updated_at = now();
    INSERT INTO audit_log (actor_id, action, subject, meta)
    SELECT id, 'staff.bootstrap', id::text, jsonb_build_object('via', 'scripts/create-admin.mjs') FROM account WHERE msisdn = :'msisdn';
  `);
} catch { process.exit(1); }
console.log(`Staff admin ready: ${name} (…${msisdn.slice(-3)}). Sign in to the console with that number.`);
