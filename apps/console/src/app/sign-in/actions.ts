'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACCESS, REFRESH, REFRESH_MAX_AGE, apiUrl, cookieOptions } from '@/lib/tokens';

export interface SignInState { step: 'phone' | 'code'; challengeId?: string; msisdn?: string; error?: string }

async function post(path: string, body: unknown) {
  const res = await fetch(apiUrl() + path, {
    method: 'POST', cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function signIn(prev: SignInState, form: FormData): Promise<SignInState> {
  if (prev.step === 'phone') {
    const msisdn = String(form.get('msisdn') ?? '').trim();
    const r = await post('/auth/otp', { msisdn });
    if (r.status !== 201) return { step: 'phone', msisdn, error: r.body?.title ?? 'Could not send a code' };
    return { step: 'code', challengeId: r.body.challenge_id, msisdn };
  }

  const code = String(form.get('code') ?? '').trim();
  // staff_only: the API creates no account and issues no session unless this number is staff.
  const r = await post('/auth/verify', { challenge_id: prev.challengeId, code, staff_only: true });
  if (r.status !== 200) {
    const retry = r.body?.code === 'OTP_INVALID' || r.body?.code === 'VALIDATION';
    return { ...prev, step: retry ? 'code' : 'phone', error: r.body?.title ?? 'Could not sign in' };
  }
  const jar = await cookies();
  jar.set(ACCESS, r.body.access, cookieOptions(r.body.expires_in));
  jar.set(REFRESH, r.body.refresh, cookieOptions(REFRESH_MAX_AGE));
  redirect('/');
}

export async function signOut() {
  const jar = await cookies();
  const access = jar.get(ACCESS)?.value;
  if (access) {
    await fetch(`${apiUrl()}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${access}` } }).catch(() => undefined);
  }
  jar.delete(ACCESS);
  jar.delete(REFRESH);
  redirect('/sign-in');
}
