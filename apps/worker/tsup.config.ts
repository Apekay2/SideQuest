import { defineConfig } from 'tsup';

// The worker image also carries the operator commands: drain, reconcile, and the migrator
// (run as a one-off job before a deploy, with MIGRATIONS_DIR pointing at the copied SQL).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'drain-cli': 'src/drain-cli.ts',
    'reconcile-cli': 'src/reconcile-cli.ts',
    migrate: '../../packages/db/scripts/migrate.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@sidequest\//],
  // Everything else stays a runtime import. Inlining CommonJS packages (pino, postgres) into
  // an ESM bundle breaks their require() calls at boot.
  external: [/^(?!@sidequest\/)[^./]/],
});
