'use server';

import { redirect } from 'next/navigation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The rail's "money trace" box: an errand id in, its trace page out. */
export async function findErrand(form: FormData) {
  const id = String(form.get('errand') ?? '').trim().toLowerCase();
  redirect(UUID.test(id) ? `/errands/${id}` : '/errands/not-an-id');
}
