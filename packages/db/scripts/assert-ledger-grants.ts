// scripts/assert-ledger-grants.ts
// The ledger's immutability is structural, not conventional: no login role may UPDATE, DELETE
// or TRUNCATE a ledger or record-of-decision table. 0006 had to revoke an UPDATE on posting that
// 0003 granted the worker; this gate makes sure no later migration quietly grants it back.
//
// Run with a superuser connection after `migrate:up` (CI's migration job does).

import { Client } from 'pg';

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) { console.error('DATABASE_URL required'); process.exit(2); }

const APPEND_ONLY = ['posting', 'posting_group', 'ruling', 'audit_log'];
const ROLES = ['sidequest_app', 'sidequest_worker', 'sidequest_ops'];
const FORBIDDEN = ['UPDATE', 'DELETE', 'TRUNCATE'];

const client = new Client({ connectionString: ADMIN });
await client.connect();

const { rows } = await client.query<{ role: string; tbl: string; priv: string }>(`
  SELECT r.role, t.tbl, p.priv
    FROM unnest($1::text[]) AS r(role)
   CROSS JOIN unnest($2::text[]) AS t(tbl)
   CROSS JOIN unnest($3::text[]) AS p(priv)
   WHERE has_table_privilege(r.role, 'public.' || t.tbl, p.priv)
   ORDER BY 1, 2, 3`, [ROLES, APPEND_ONLY, FORBIDDEN]);

// A column-level UPDATE grant is still an UPDATE: has_table_privilege misses those.
const { rows: cols } = await client.query<{ role: string; tbl: string; col: string }>(`
  SELECT grantee AS role, table_name AS tbl, column_name AS col
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND privilege_type = 'UPDATE'
     AND grantee = ANY($1::text[]) AND table_name = ANY($2::text[])
   ORDER BY 1, 2, 3`, [ROLES, APPEND_ONLY]);

await client.end();

if (rows.length || cols.length) {
  for (const r of rows) console.error(`  FAIL  ${r.role} has ${r.priv} on ${r.tbl}`);
  for (const c of cols) console.error(`  FAIL  ${c.role} has UPDATE on ${c.tbl}.${c.col}`);
  console.error(`::error::ledger gate: ${rows.length + cols.length} grant(s) break append-only`);
  process.exit(1);
}
console.log(`Ledger gate passed: ${APPEND_ONLY.join(', ')} are append-only for ${ROLES.join(', ')}.`);
