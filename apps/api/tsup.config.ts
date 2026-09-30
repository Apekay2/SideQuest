import { defineConfig } from 'tsup';

// One ESM bundle for the container. Workspace packages ship as TypeScript source, so they are
// bundled in; npm dependencies stay external and come from the image's node_modules.
export default defineConfig({
  entry: { index: 'src/index.ts' },
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
