'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleSos(id: string, step: 'acknowledge' | 'resolve', note?: string): Promise<{ ok: boolean; error?: string }> {
  if (!UUID.test(id)) return { ok: false, error: 'Not a case id' };
  try {
    await api.post(`/ops/sos/${id}/${step}`, step === 'resolve' ? { note } : {});
    revalidatePath('/sos');
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.title };
    throw e;
  }
}
