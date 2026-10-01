'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';

export interface ActionResult { ok: boolean; error?: string; message?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(id: string, fn: () => Promise<string>): Promise<ActionResult> {
  if (!UUID.test(id)) return { ok: false, error: 'Not an account id' };
  try {
    const message = await fn();
    revalidatePath(`/users/${id}`);
    return { ok: true, message };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.title };
    throw e;
  }
}

export async function suspend(id: string, reason: string) {
  return run(id, async () => {
    const r = await api.post<{ sessions_revoked: number }>(`/ops/accounts/${id}/suspend`, { reason });
    return `Suspended. Signed out of ${r.sessions_revoked} session${r.sessions_revoked === 1 ? '' : 's'}; they have been told by SMS.`;
  });
}

export async function reinstate(id: string, reason: string) {
  return run(id, async () => { await api.post(`/ops/accounts/${id}/reinstate`, { reason }); return 'Reinstated. They have been told by SMS.'; });
}

export async function setGrants(id: string, grants: string[]) {
  return run(id, async () => { await api.put(`/ops/accounts/${id}/grants`, { grants }); return 'Saved. It takes effect when their session next refreshes (within 15 minutes).'; });
}

export async function makeStaff(id: string, grants: string[]) {
  return run(id, async () => { await api.post(`/ops/accounts/${id}/make-staff`, { grants }); return 'Now staff. They sign in to this console with their number.'; });
}
