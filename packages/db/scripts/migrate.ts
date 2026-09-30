// packages/db/scripts/migrate.ts
// Forward-only migration runner. Applies every numbered file in ../migrations that is not yet
// recorded in schema_migrations, in order, each file as one unit. Never edits or reverts.
//
//   DATABASE_URL          owner/superuser connection (migrations own the schema)
//   APP_ROLE_PASSWORD     optional; when set outside production, the three login roles get
//                         this password so local dev and CI can connect as them.

import postgres from 'postgres';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const sql = postgres(url, { max: 1, onnotice: () => {} });

await sql`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text PRIMARY KEY,
    sha256     text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

const applied = new Map((await sql<{ name: string; sha256: string }[]>`SELECT name, sha256 FROM schema_migrations`)
  .map((r) => [r.name, r.sha256]));

const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
let ran = 0;
for (const file of files) {
  const body = readFileSync(join(dir, file), 'utf8');
  const sha = createHash('sha256').update(body).digest('hex');
  const prior = applied.get(file);
  if (prior) {
    // A shipped migration that changed on disk is a deploy hazard: the database and the repo
    // now disagree about history. Refuse loudly rather than guess.
    if (prior !== sha) {
      console.error(`${file} has changed since it was applied. Add a new migration instead of editing it.`);
      process.exit(1);
    }
    continue;
  }
  process.stdout.write(`applying ${file} … `);
  if (/^-- migrate:autocommit/m.test(body)) {
    // ALTER TYPE … ADD VALUE cannot be used in the transaction that added it. Such files are
    // marked and run statement by statement; they must not contain dollar-quoted bodies,
    // because this split is a plain semicolon split.
    if (body.includes('$$')) throw new Error(`${file}: autocommit files cannot contain $$ bodies`);
    const statements = body
      .split(/;\s*$/m)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    for (const st of statements) await sql.unsafe(st);
  } else {
    // Simple-protocol multi-statement execution. Files that manage their own BEGIN/COMMIT
    // keep them; files that do not run as one implicit transaction.
    await sql.unsafe(body);
  }
  await sql`INSERT INTO schema_migrations (name, sha256) VALUES (${file}, ${sha})`;
  console.log('ok');
  ran++;
}

const pw = process.env.APP_ROLE_PASSWORD;
if (pw && process.env.NODE_ENV !== 'production') {
  for (const role of ['sidequest_app', 'sidequest_worker', 'sidequest_ops']) {
    await sql.unsafe(`ALTER ROLE ${role} PASSWORD '${pw.replace(/'/g, "''")}'`);
  }
  console.log('login roles given the development password');
}

console.log(ran === 0 ? 'up to date' : `${ran} migration(s) applied`);
await sql.end();
