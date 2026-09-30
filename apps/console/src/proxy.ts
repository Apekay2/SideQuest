// Runs before every console page: sets a per-request CSP nonce, keeps the officer's access
// token fresh (rotating the refresh token as the API requires), and sends anyone without a
// staff session to sign in.

import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS, REFRESH, REFRESH_MAX_AGE, apiUrl, cookieOptions, peek } from './lib/tokens';
import { rotate } from './lib/refresh';

const REFRESH_AHEAD_SECONDS = 60;

function csp(nonce: string): string {
  const dev = process.env.NODE_ENV === 'development';
  // Evidence and KYC photos load straight from presigned storage URLs.
  const images = [apiUrl(), process.env.STORAGE_PUBLIC_ORIGIN].filter(Boolean).map((u) => new URL(u!).origin).join(' ');
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' ${dev ? `'unsafe-inline'` : `'nonce-${nonce}'`}`,
    `img-src 'self' blob: data: ${images}`,
    `font-src 'self'`,
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ');
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = csp(nonce);
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', policy);

  const finish = (res: NextResponse) => { res.headers.set('content-security-policy', policy); return res; };
  const toSignIn = (reason?: string) => {
    const url = new URL('/sign-in', request.url);
    if (reason) url.searchParams.set(reason, '1');
    const res = NextResponse.redirect(url);
    res.cookies.delete(ACCESS);
    res.cookies.delete(REFRESH);
    return finish(res);
  };

  const onSignIn = request.nextUrl.pathname === '/sign-in';
  const claims = peek(request.cookies.get(ACCESS)?.value);
  const refresh = request.cookies.get(REFRESH)?.value;
  const now = Math.floor(Date.now() / 1000);

  if (onSignIn) {
    if (claims && claims.role === 'staff' && claims.exp > now) return finish(NextResponse.redirect(new URL('/', request.url)));
    return finish(NextResponse.next({ request: { headers } }));
  }
  if (!refresh) return toSignIn();
  if (claims && claims.role !== 'staff') return toSignIn();
  if (claims && claims.exp - now > REFRESH_AHEAD_SECONDS) return finish(NextResponse.next({ request: { headers } }));

  // Expired or about to: rotate (once, however many requests are holding this token).
  const session = await rotate(refresh);
  if (!session) return toSignIn('expired');
  if (session.account.role !== 'staff') return toSignIn();

  // Hand the new token to this render (as a request cookie) and to the browser (Set-Cookie).
  request.cookies.set(ACCESS, session.access);
  request.cookies.set(REFRESH, session.refresh);
  headers.set('cookie', request.cookies.toString());
  const next = NextResponse.next({ request: { headers } });
  next.cookies.set(ACCESS, session.access, cookieOptions(session.expires_in));
  next.cookies.set(REFRESH, session.refresh, cookieOptions(REFRESH_MAX_AGE));
  return finish(next);
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)' }],
};
