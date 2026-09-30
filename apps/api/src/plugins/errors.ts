// apps/api/src/plugins/errors.ts
// The one error type route code throws. Anything else that escapes a handler becomes a
// scrubbed 500 in hardening.ts, so an unexpected message never reaches a client.

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Not found') => new AppError(404, 'NOT_FOUND', what);
export const forbidden = (what = 'Not allowed') => new AppError(403, 'FORBIDDEN', what);
export const conflict = (code: string, what: string, details?: Record<string, unknown>) =>
  new AppError(409, code, what, details);
