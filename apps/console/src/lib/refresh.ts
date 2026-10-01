// One rotation per refresh token, however many requests arrive holding it.
//
// A page load fires several requests at once (the page, prefetches of the sidebar links). If
// the access token has expired, each would present the same refresh token; the API treats a
// second presentation of a spent token as theft and revokes the family, signing the officer
// out. So concurrent callers share one in-flight rotation, and stragglers that arrive shortly
// after get its result instead of replaying the spent token.
//
// This is per process. Run more than one console instance and the load balancer must pin an
// officer to one (sticky sessions), or this state must move to a shared store.

import { apiUrl } from './tokens';

export interface Rotated { access: string; refresh: string; expires_in: number; account: { role: string } }

const SHARE_FOR_MS = 30_000;
const recent = new Map<string, { at: number; result: Promise<Rotated | null> }>();

export function rotate(refresh: string, fetcher: typeof fetch = fetch): Promise<Rotated | null> {
  const now = Date.now();
  for (const [k, v] of recent) if (now - v.at > SHARE_FOR_MS) recent.delete(k);
  const hit = recent.get(refresh);
  if (hit) return hit.result;

  const result = fetcher(`${apiUrl()}/auth/refresh`, {
    method: 'POST', cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh }),
  }).then(async (res) => (res.ok ? (await res.json()) as Rotated : null)).catch(() => null);
  recent.set(refresh, { at: now, result });
  return result;
}
