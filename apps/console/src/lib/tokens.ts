// Cookie names and token reading, shared by the proxy and server code. No 'server-only' import
// here: the proxy bundle imports it too.
//
// The console holds the API's tokens in its own httpOnly cookies; the browser never sees them
// and never talks to the API directly (except to load a presigned image).

export const ACCESS = 'sq_ops_access';
export const REFRESH = 'sq_ops_refresh';

export const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: maxAgeSeconds,
});

export const REFRESH_MAX_AGE = 12 * 3600;   // a console shift; the API's refresh family lives longer

export interface Claims { sub: string; role: string; ent: string[]; exp: number }

/**
 * Reads the access token's claims WITHOUT verifying the signature. Used only to decide what to
 * draw (which nav items, whether it is time to refresh); every decision that matters is the
 * API's, which verifies the token on each call.
 */
export function peek(token: string | undefined): Claims | null {
  if (!token) return null;
  try {
    const body = token.split('.')[1];
    if (!body) return null;
    const json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Claims>;
    if (typeof json.sub !== 'string' || typeof json.exp !== 'number') return null;
    return { sub: json.sub, role: String(json.role ?? ''), ent: Array.isArray(json.ent) ? json.ent.map(String) : [], exp: json.exp };
  } catch { return null; }
}

export const apiUrl = () => process.env.API_URL ?? 'http://localhost:3000';
