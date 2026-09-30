// apps/api/src/index.ts
// Entrypoint. Config is validated before anything connects; an invalid environment exits
// with the list of problems and no partial boot.

import { config, redactedConfig } from '@sidequest/config';
import { assertMarketsConsistent } from '@sidequest/domain/money/currency';
import { logger } from '@sidequest/observability';
import { build, buildDeps } from './server.js';

const cfg = config();
assertMarketsConsistent();
logger.info({ config: redactedConfig(cfg) }, 'booting api');

const app = await build(buildDeps(cfg));
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    logger.info({ sig }, 'shutting down');
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}
