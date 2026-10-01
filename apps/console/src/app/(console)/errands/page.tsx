import Link from 'next/link';
import { api, can, officer } from '@/lib/api';
import { ksh, label, when, ERRAND_KIND, ERRAND_STATUS, statusTone } from '@/lib/format';

interface Row { id: string; title: string; kind: string; status: string; updated_at: string; spend_cap_cents: number; spent_cents: number;
                agreed_fee_cents: number | null; requester_name: string; runner_name: string | null; requester_id: string; runner_id: string | null }

const FILTERS = [['live', 'Live'], ['disputed', 'Disputed'], ['settled', 'Settled'], ['closed', 'Cancelled or expired'], ['all', 'All']] as const;

export default async function Errands({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const sp = await searchParams;
  const status = FILTERS.some(([v]) => v === sp.status) ? sp.status! : 'live';
  const who = await officer();
  const qs = new URLSearchParams({ status });
  if (sp.q) qs.set('q', sp.q);
  const { data } = await api.get<{ data: Row[] }>(`/ops/errands?${qs}`);
  const trace = can(who, 'ledger.read');
  return (
    <>
      <h1>Errands</h1>
      <p className="lede">Most recently active first.{trace ? ' Open one for its money trace.' : ''}</p>
      <form className="searchbar" role="search" action="/errands">
        <label className="visually-hidden" htmlFor="eq">Search errands</label>
        <input id="eq" name="q" defaultValue={sp.q} placeholder="Title or errand id" autoComplete="off" />
        <input type="hidden" name="status" value={status} />
        <button className="btn sm terracotta" type="submit">Search</button>
      </form>
      <nav className="tabs" aria-label="Filter">
        {FILTERS.map(([v, l]) => (
          <Link key={v} href={`/errands?status=${v}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ''}`} aria-current={status === v ? 'page' : undefined}>{l}</Link>
        ))}
      </nav>
      {data.length === 0 ? <p className="empty">No errands match.</p> : (
        <table className="table">
          <thead><tr><th scope="col">Errand</th><th scope="col">Requester</th><th scope="col">Runner</th><th scope="col">Status</th><th scope="col" className="num">Spent / cap</th><th scope="col">Updated</th></tr></thead>
          <tbody>
            {data.map((e) => (
              <tr key={e.id}>
                <td>{trace ? <Link href={`/errands/${e.id}`}>{e.title}</Link> : e.title}<div className="muted small">{label(ERRAND_KIND, e.kind)}</div></td>
                <td><Link href={`/users/${e.requester_id}`}>{e.requester_name}</Link></td>
                <td>{e.runner_id ? <Link href={`/users/${e.runner_id}`}>{e.runner_name}</Link> : <span className="muted">—</span>}</td>
                <td><span className={`pill ${statusTone(e.status)}`}>{label(ERRAND_STATUS, e.status)}</span></td>
                <td className="num">KSh {ksh(e.spent_cents)} / {ksh(e.spend_cap_cents)}</td>
                <td className="muted nowrap">{when(e.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
