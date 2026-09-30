// scripts/assert-rls-coverage.ts
// The RLS gate. Runs against the shadow database after `migrate:up`, in CI, on every commit.
//
// These are the three queries at the foot of 03c-rls.sql, plus two the panel added after
// finding P-1: a policy can exist and still be wrong, but a table with NO policy is always
// wrong, and a role with BYPASSRLS makes the whole file decorative.
//
// Run with a superuser connection — this script inspects the catalogue, it does not test
// enforcement. Enforcement is code/api/test/security/rls.test.ts, which must run as
// sidequest_app or it proves nothing.

import { Client } from 'pg';

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) { console.error('DATABASE_URL required'); process.exit(2); }

/** Tables that legitimately hold no per-actor data. Anything not listed must have RLS.
 *  Keep this list short and argue about every addition. */
const REFERENCE_TABLES = new Set([
  'money_currency', 'market', 'schema_migrations', 'spatial_ref_sys',
]);

interface Check { name: string; sql: string; explain: (rows: any[]) => string }

const CHECKS: Check[] = [
  {
    name: 'every table has RLS enabled and forced',
    // FORCE matters as much as ENABLE: without it the table owner bypasses policy, and the
    // owner is the role a leaked DATABASE_URL is most likely to hold.
    sql: `SELECT c.relname,
                 c.relrowsecurity      AS enabled,
                 c.relforcerowsecurity AS forced
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
           ORDER BY c.relname`,
    explain: (rows) => rows
      .map((r) => `  ${r.relname}: enabled=${r.enabled} forced=${r.forced}`)
      .join('\n'),
  },
  {
    name: 'every RLS table has at least one policy',
    // An RLS table with no policy denies everything, which fails safe but breaks the
    // product — and is the usual symptom of a new table shipped without an authorisation
    // decision having been made.
    sql: `SELECT c.relname
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
             AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
           ORDER BY c.relname`,
    explain: (rows) => rows.map((r) => `  ${r.relname} has RLS but no policy`).join('\n'),
  },
  {
    name: 'no application role can bypass RLS',
    sql: `SELECT rolname, rolsuper, rolbypassrls
            FROM pg_roles
           WHERE rolname LIKE 'sidequest%' AND (rolbypassrls OR rolsuper)`,
    explain: (rows) => rows
      .map((r) => `  ${r.rolname}: superuser=${r.rolsuper} bypassrls=${r.rolbypassrls}`)
      .join('\n'),
  },
  {
    name: 'the ledger is append-only at the grant level',
    // No internet-reachable role may UPDATE a posting or DELETE any ledger row. Correction
    // is a new posting group; that is the whole audit story.
    sql: `SELECT table_name, privilege_type, grantee
            FROM information_schema.role_table_grants
           WHERE table_schema = 'public'
             AND grantee IN ('sidequest_app','sidequest_worker','sidequest_ops','PUBLIC')
             AND ( (table_name = 'posting' AND privilege_type IN ('UPDATE','DELETE'))
                OR (table_name IN ('posting_group','card_attempt','mpesa_event','audit_log')
                    AND privilege_type = 'DELETE') )`,
    explain: (rows) => rows
      .map((r) => `  ${r.grantee} has ${r.privilege_type} on ${r.table_name}`)
      .join('\n'),
  },
  {
    name: 'nothing is granted to PUBLIC',
    sql: `SELECT table_name, privilege_type
            FROM information_schema.role_table_grants
           WHERE table_schema = 'public' AND grantee = 'PUBLIC'`,
    explain: (rows) => rows.map((r) => `  PUBLIC has ${r.privilege_type} on ${r.table_name}`).join('\n'),
  },
  {
    name: 'no policy is unconditionally permissive for the app role',
    // `USING (true)` on a user-facing table is how an RLS rollout gets quietly reverted
    // under deadline pressure. Worker-role policies are legitimately `true` and excluded.
    sql: `SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS qual
            FROM pg_policy p
            JOIN pg_class c ON c.oid = p.polrelid
           WHERE 'sidequest_app' = ANY (SELECT rolname FROM pg_roles WHERE oid = ANY (p.polroles))
             AND pg_get_expr(p.polqual, p.polrelid) = 'true'
             AND c.relname NOT IN ('otp_challenge', 'outbox_event')`,
    explain: (rows) => rows
      .map((r) => `  ${r.relname}.${r.polname} is USING (true) for sidequest_app`)
      .join('\n'),
  },
];

const client = new Client({ connectionString: ADMIN });
await client.connect();

let failed = 0;

// Report the reference-table exemptions explicitly, so the allowlist cannot quietly grow.
const { rows: allTables } = await client.query(
  `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`);
const unexpected = allTables
  .map((r) => r.relname)
  .filter((t) => REFERENCE_TABLES.has(t) === false);
console.log(`Inspecting ${unexpected.length} tables (${REFERENCE_TABLES.size} reference tables exempt)`);

for (const check of CHECKS) {
  const { rows } = await client.query(check.sql);
  const offending = rows.filter((r: any) => !REFERENCE_TABLES.has(r.relname ?? r.table_name));
  if (offending.length === 0) {
    console.log(`  ok    ${check.name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${check.name}`);
    console.error(check.explain(offending));
    // GitHub annotation, so the failure lands on the diff rather than in a log tail.
    console.error(`::error::RLS gate: ${check.name} (${offending.length} offending)`);
  }
}

await client.end();

if (failed > 0) {
  console.error(`\n${failed} RLS gate(s) failed. See 03c-rls.sql and 09-appsec-audit.md §9.5.`);
  process.exit(1);
}
console.log('\nRLS coverage gate passed.');
