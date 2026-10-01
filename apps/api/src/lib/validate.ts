// apps/api/src/lib/validate.ts
// Request validation against the shared contracts. One helper, one error shape: a 400 with
// the failing paths, and never the offending values (they may be an msisdn or a coordinate).

import type { z } from 'zod';
import { AppError } from '../plugins/errors.js';

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw new AppError(400, 'VALIDATION', 'Request is not valid', {
      fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params. A malformed id is a 404, not a 400 or a 500 from a failed uuid cast. */
export function ids<K extends string>(params: unknown, ...keys: K[]): Record<K, string> {
  const p = (params ?? {}) as Record<string, unknown>;
  const out = {} as Record<K, string>;
  for (const k of keys) {
    const v = p[k];
    if (typeof v !== 'string' || !UUID.test(v)) throw new AppError(404, 'NOT_FOUND', 'Not found');
    out[k] = v;
  }
  return out;
}
