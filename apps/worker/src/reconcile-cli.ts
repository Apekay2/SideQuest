// Run the reconciliation now and print the findings. Exit code 1 when anything would page.
import { config } from '@sidequest/config';
import { buildWorkerDeps } from './runtime.js';
import { reconcile } from './jobs/reconcile.job.js';

const deps = buildWorkerDeps(config());
const r = await reconcile({ sql: deps.sql, issuer: deps.issuer, page: async () => {}, ticket: async () => {} });
console.log(JSON.stringify(r, null, 2));
await deps.sql.end();
deps.redis.disconnect();
process.exit(r.findings.some((f) => f.severity === 'page') ? 1 : 0);
