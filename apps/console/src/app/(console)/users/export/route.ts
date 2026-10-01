// The accounts CSV, fetched server-side with the officer's token and handed to the browser as a
// download. Every cell has already passed the API's formula guard; the export is audited there.
import { cookies } from 'next/headers';
import { ACCESS, apiUrl } from '@/lib/tokens';

export async function GET() {
  const token = (await cookies()).get(ACCESS)?.value;
  if (!token) return new Response('Sign in again', { status: 401 });
  const res = await fetch(`${apiUrl()}/ops/export/accounts.csv`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) return new Response(res.status === 403 ? 'Your access does not include exports' : 'Export failed', { status: res.status });
  return new Response(res.body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="sidequest-accounts-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
