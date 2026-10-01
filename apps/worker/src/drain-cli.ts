// Drain the outbox inline, once. For local development without a BullMQ worker running, and
// for draining parked work by hand after a fix.
import { config } from '@sidequest/config';
import { buildWorkerDeps, drain } from './runtime.js';

const deps = buildWorkerDeps(config());
console.log(await drain(deps));
await deps.sql.end();
deps.redis.disconnect();
