'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function voidCard(errandId: string, cardId: string): Promise<{ ok: boolean; error?: string }> {
  if (!UUID.test(errandId) || !UUID.test(cardId)) return { ok: false, error: 'Bad id' };
  try {
    await api.post(`/ops/cards/${cardId}/void`, {});
    revalidatePath(`/errands/${errandId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.title };
    throw e;
  }
}
