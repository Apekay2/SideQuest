// apps/mobile/src/lib/api.ts
// The only thing in the app that talks HTTP. Bearer token from the session, the device id
// the refresh token is bound to, one silent refresh on an expired access token, and a typed
// error carrying the RFC 7807 `code` the screens branch on (never the title).

import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import type { Problem, Session } from '@sidequest/contracts';
import { useSession } from './session';

export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof ApiError && err.status === 0);
}

export const newIdemKey = () => Crypto.randomUUID();

let refreshing: Promise<boolean> | null = null;

export async function refresh(): Promise<boolean> {
  // One refresh in flight at a time: concurrent 401s wait on the same rotation, because a
  // second rotation with the now-spent token would revoke the whole family (04-api.md).
  refreshing ??= (async () => {
    const s = useSession.getState();
    const token = await s.refreshToken();
    if (!token) return false;
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(s.deviceId ? { 'x-device-id': s.deviceId } : {}) },
      body: JSON.stringify({ refresh: token }),
    }).catch(() => null);
    if (!res || !res.ok) {
      if (res && res.status === 401) await s.signOut();
      return false;
    }
    await s.signedIn((await res.json()) as Session);
    return true;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export interface RequestOptions {
  /** An Idempotency-Key, stable across retries of ONE user intent. */
  idem?: string;
  signal?: AbortSignal;
  retried?: boolean;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const s = useSession.getState();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (s.access) headers.authorization = `Bearer ${s.access}`;
  if (s.deviceId) headers['x-device-id'] = s.deviceId;
  if (opts.idem) headers['idempotency-key'] = opts.idem;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: opts.signal });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', (e as Error).message);
  }

  if (res.status === 401 && !opts.retried && path !== '/auth/refresh') {
    const problem = (await res.clone().json().catch(() => null)) as Problem | null;
    if (problem?.code === 'UNAUTHENTICATED' && (await refresh())) {
      return request<T>(method, path, body, { ...opts, retried: true });
    }
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const p = json as Problem | null;
    // The terms changed since this person last accepted: the root layout shows LegalUpdate.
    if (res.status === 403 && p?.code === 'LEGAL_ACCEPTANCE_REQUIRED' && s.account) {
      useSession.getState().setAccount({ ...s.account, legal_current: false });
    }
    throw new ApiError(res.status, p?.code ?? 'UNKNOWN', p?.title ?? 'Request failed', p?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body ?? {}, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body ?? {}, opts),
  delete: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('DELETE', path, body, opts),
  /** PUT raw bytes to a presigned upload URL (storage, not the API). */
  async upload(url: string, headers: Record<string, string>, fileUri: string): Promise<void> {
    const blob = await (await fetch(fileUri)).blob();
    const res = await fetch(url, { method: 'PUT', headers, body: blob });
    if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', 'Upload failed');
  },
};

/** On launch: if a refresh token survives in the keystore, turn it into a session silently. */
export async function restoreSession(): Promise<boolean> {
  return refresh();
}
