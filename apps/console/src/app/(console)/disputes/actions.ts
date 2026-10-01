'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';
import type { Outcome } from '@/lib/split';

export interface RuleResult { ok: boolean; error?: string }

export async function rule(disputeId: string, body: { outcome: Outcome; requester_cents: number; runner_cents: number; rationale: string }): Promise<RuleResult> {
  try {
    await api.post(`/ops/disputes/${encodeURIComponent(disputeId)}/rule`, body);
    revalidatePath('/disputes', 'layout');
    revalidatePath('/rulings');
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      const held = typeof e.details?.escrow_cents === 'number' ? ` Escrow now holds KSh ${(e.details.escrow_cents as number) / 100}.` : '';
      return { ok: false, error: `${e.title}.${held}` };
    }
    throw e;
  }
}
