import Link from 'next/link';
import { api, can, officer } from '@/lib/api';
import { when } from '@/lib/format';

interface Row { id: string; display_name: string; role: string; verification_tier: number; created_at: string;
                suspended_at: string | null; msisdn_masked: string | null; staff_grants: string[] }

const ROLES = [['', 'Everyone'], ['requester', 'Requesters'], ['runner', 'Runners'], ['staff', 'Staff']] as const;

export default async function Users({ searchParams }: { searchParams: Promise<{ q?: string; role?: string; status?: string }> }) {
  const sp = await searchParams;
  const who = await officer();
  const qs = new URLSearchParams();
  if (sp.q) qs.set('q', sp.q);
  if (sp.role && ['requester', 'runner', 'staff'].includes(sp.role)) qs.set('role', sp.role);
  if (sp.status === 'suspended' || sp.status === 'active') qs.set('status', sp.status);
  let rows: Row[] = [], error: string | null = null;
  try { rows = (await api.get<{ data: Row[] }>(`/ops/accounts?${qs}`)).data; }
  catch (e) { error = e instanceof Error ? e.message : 'Search failed'; }
  const link = (over: Record<string, string>) => {
    const p = new URLSearchParams(qs);
    for (const [k, v] of Object.entries(over)) { if (v) p.set(k, v); else p.delete(k); }
    return `/users?${p}`;
  };

  return (
    <>
      <div className="title-row">
        <h1>Users</h1>
        {can(who, 'ops.read') && <a className="btn sm outline" href="/users/export" download>Export CSV</a>}
      </div>
      <p className="lede">Find a customer, runner or officer by name, full phone number or id. Phone numbers are matched in full, never by prefix.</p>
      <form className="searchbar" role="search" action="/users">
        <label className="visually-hidden" htmlFor="q">Search users</label>
        <input id="q" name="q" defaultValue={sp.q} placeholder="Name, 07… number, or id" autoComplete="off" />
        {sp.role && <input type="hidden" name="role" value={sp.role} />}
        {sp.status && <input type="hidden" name="status" value={sp.status} />}
        <button className="btn sm terracotta" type="submit">Search</button>
      </form>
      <nav className="tabs" aria-label="Filter">
        {ROLES.map(([v, l]) => <Link key={l} href={link({ role: v })} aria-current={(sp.role ?? '') === v ? 'page' : undefined}>{l}</Link>)}
        <Link href={link({ status: sp.status === 'suspended' ? '' : 'suspended' })} aria-current={sp.status === 'suspended' ? 'page' : undefined}>Suspended only</Link>
      </nav>
      {error ? <p className="warn" role="alert">{error}</p> : rows.length === 0 ? <p className="empty">Nobody matches.</p> : (
        <table className="table">
          <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Tier</th><th scope="col">Phone</th><th scope="col">Joined</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td><Link href={`/users/${a.id}`}>{a.display_name}</Link></td>
                <td>{a.role}</td>
                <td>{a.role === 'staff' ? `${a.staff_grants.length} grant${a.staff_grants.length === 1 ? '' : 's'}` : `tier ${a.verification_tier}`}</td>
                <td className="mono">{a.msisdn_masked}</td>
                <td className="muted nowrap">{when(a.created_at)}</td>
                <td>{a.suspended_at ? <span className="pill strong">Suspended</span> : <span className="pill sage">Active</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
