'use server';

import { api, ApiError } from '@/lib/api';

export interface DecideResult { ok: boolean; status?: 'approved' | 'rejected'; error?: string }

export async function decide(caseId: string, approve: boolean, reason?: string): Promise<DecideResult> {
  try {
    const r = await api.post<{ status: 'approved' | 'rejected' }>(`/ops/kyc/${encodeURIComponent(caseId)}/decide`,
      approve ? { approve: true } : { approve: false, reason });
    // No revalidation: the row stays, showing its outcome, until the officer moves on. The
    // queue is rendered fresh (no-store) on the next visit.
    return { ok: true, status: r.status };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.title };
    throw e;
  }
}
