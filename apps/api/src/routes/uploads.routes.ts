// apps/api/src/routes/uploads.routes.ts
// The local storage driver's endpoint: accepts a PUT and serves a GET against a URL the API
// signed, standing in for R2 on a laptop. Registered only when STORAGE_DRIVER=local, which
// production config refuses.

import type { FastifyInstance } from 'fastify';
import { AppError } from '../plugins/errors.js';

const TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_BYTES = 8 * 1024 * 1024;

export default async function uploadRoutes(app: FastifyInstance) {
  const store = app.deps.localStorage;
  if (!store) return;

  await app.register(async (scope) => {
    for (const t of TYPES) {
      scope.addContentTypeParser(t, { parseAs: 'buffer', bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));
    }

    scope.put('/uploads/*', { bodyLimit: MAX_BYTES }, async (req, reply) => {
      const key = (req.params as { '*': string })['*'];
      const q = req.query as { exp?: string; sig?: string };
      const ct = String(req.headers['content-type'] ?? '');
      if (!store.verify('PUT', key, Number(q.exp), String(q.sig ?? ''), ct)) {
        throw new AppError(403, 'FORBIDDEN', 'Upload URL expired or invalid');
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new AppError(400, 'VALIDATION', 'Empty upload');
      await store.write(key, req.body);
      return reply.code(200).send();
    });

    scope.get('/uploads/*', async (req, reply) => {
      const key = (req.params as { '*': string })['*'];
      const q = req.query as { exp?: string; sig?: string };
      if (!store.verify('GET', key, Number(q.exp), String(q.sig ?? ''))) {
        throw new AppError(403, 'FORBIDDEN', 'Link expired or invalid');
      }
      const body = await store.read(key);
      if (!body) throw new AppError(404, 'NOT_FOUND', 'Not found');
      const type = key.endsWith('.png') ? 'image/png' : key.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
      // Served as an attachment-safe image: nosniff is set globally, and nothing here renders
      // as a document (no SVG, no HTML is ever accepted for upload).
      // The app shows these from another origin; the signature, not the origin, is the
      // access control, so this one response relaxes the global same-origin CORP header.
      return reply.type(type).header('Cache-Control', 'private, max-age=60')
        .header('Cross-Origin-Resource-Policy', 'cross-origin').send(body);
    });
  });
}
