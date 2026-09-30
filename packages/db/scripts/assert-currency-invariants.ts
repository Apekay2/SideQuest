// scripts/assert-currency-invariants.ts
// The verification queries at the foot of 0005_currency.sql, as a CI gate. Any row is a
// failure. Also asserts that the database's enabled currencies match SUPPORTED in
// packages/domain/src/money/currency.ts, which 0005 says the boot check depends on.

import postgres from 'postgres';
import { SUPPORTED } from '@sidequest/domain/money/currency';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const sql = postgres(url, { max: 1, onnotice: () => {} });

const checks: Array<[string, () => PromiseLike<readonly unknown[]>]> = [
  ['postings agree with their group currency', () => sql`
    SELECT p.group_id FROM posting p JOIN posting_group g ON g.id = p.group_id
     WHERE p.currency <> g.currency LIMIT 20`],
  ['no enabled market sits on a disabled currency', () => sql`
    SELECT m.country FROM market m JOIN money_currency c ON c.code = m.currency
     WHERE m.enabled AND NOT c.enabled`],
  ['the ledger balances per currency', () => sql`
    SELECT currency, sum(amount_cents) AS delta FROM posting
     GROUP BY currency HAVING sum(amount_cents) <> 0`],
  ['platform accounts are classed as platform money', () => sql`
    SELECT id FROM posting
     WHERE (account IN ('platform_fee','service_fee_requester','maintenance_fee_runner')) <> (fund_class = 'platform')
     LIMIT 20`],
];

let failed = 0;
for (const [name, run] of checks) {
  const rows = await run();
  if (rows.length === 0) console.log(`  ok    ${name}`);
  else { failed++; console.error(`  FAIL  ${name}\n${JSON.stringify(rows, null, 2)}`); }
}

const enabled = (await sql<{ code: string }[]>`SELECT code FROM money_currency WHERE enabled ORDER BY code`)
  .map((r) => r.code);
const code = [...SUPPORTED].sort();
if (JSON.stringify(enabled) !== JSON.stringify(code)) {
  failed++;
  console.error(`  FAIL  money_currency.enabled ${JSON.stringify(enabled)} ≠ SUPPORTED ${JSON.stringify(code)}`);
} else {
  console.log('  ok    enabled currencies match SUPPORTED');
}

await sql.end();
if (failed) process.exit(1);
console.log('\nCurrency invariants hold.');
