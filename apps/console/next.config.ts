import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Security headers that do not depend on the request live here; the CSP carries a per-request
// nonce and is set in src/proxy.ts.
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  output: 'standalone',
  // Trace from the monorepo root so the standalone bundle carries hoisted dependencies.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Cache-Control', value: 'no-store' },
      ],
    }];
  },
};

export default config;
