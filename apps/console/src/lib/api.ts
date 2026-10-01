// Server-side calls from the console to the API's /ops surface, as the signed-in officer.

import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACCESS, apiUrl, peek, type Claims } from './tokens';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly title: string, readonly details?: Record<string, unknown>) {
    super(title);
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const token = (await cookies()).get(ACCESS)?.value;
  if (!token) redirect('/sign-in');
  let res: Response;
  try {
    res = await fetch(apiUrl() + path, {
      method,
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(503, 'API_UNREACHABLE', 'The SideQuest API is unreachable');
  }
  // The proxy refreshes ahead of expiry; a 401 here means the session was revoked.
  if (res.status === 401) redirect('/sign-in?expired=1');
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, json?.code ?? 'ERROR', json?.title ?? `Request failed (${res.status})`, json?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T>(path: string, body: unknown = {}) => call<T>('PUT', path, body),
};

/**
 * For reads a page can live without: returns null on 403 (the officer lacks the entitlement)
 * so the page can say so instead of failing whole.
 */
export async function tryGet<T>(path: string): Promise<T | null> {
  try { return await api.get<T>(path); } catch (e) {
    if (e instanceof ApiError && e.status === 403) return null;
    throw e;
  }
}

export async function officer(): Promise<Claims | null> {
  return peek((await cookies()).get(ACCESS)?.value);
}

export const can = (c: Claims | null, ent: string) => !!c && c.ent.includes(ent);
