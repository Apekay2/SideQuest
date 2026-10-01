import Link from 'next/link';
import { api, can, officer } from '@/lib/api';
import { waited, when } from '@/lib/format';
import { SosActions } from './SosActions';

interface Case {
  id: string; errand_id: string; lat: number | null; lng: number | null; created_at: string; age_seconds: number;
  acknowledged_at: string | null; acknowledged_by_name: string | null; resolved_at: string | null; resolved_by_name: string | null;
  resolution_note: string | null; title: string; errand_status: string; raised_by_name: string; raised_by_role: string; raised_by: string;
}

export default async function Sos({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const resolved = status === 'resolved';
  const who = await officer();
  const { data } = await api.get<{ data: Case[] }>(`/ops/sos?status=${resolved ? 'resolved' : 'open'}`);
  return (
    <>
      <h1>SOS</h1>
      <p className="lede">Someone pressed SOS during an errand. Call them first: the app has already shown them the emergency number. Oldest first.</p>
      <nav className="tabs" aria-label="Filter">
        <Link href="/sos" aria-current={!resolved ? 'page' : undefined}>Open</Link>
        <Link href="/sos?status=resolved" aria-current={resolved ? 'page' : undefined}>Resolved</Link>
      </nav>
      {data.length === 0 ? <p className="empty">{resolved ? 'Nothing resolved yet.' : 'No open SOS. Good.'}</p> : (
        <div className="stack">
          {data.map((c) => (
            <article key={c.id} className={`panel sos${!c.resolved_at && !c.acknowledged_at ? ' urgent' : ''}`} aria-labelledby={`sos-${c.id}`}>
              <div className="panel-head">
                <h2 id={`sos-${c.id}`} className="h3">{c.raised_by_name} <span className="muted">({c.raised_by_role})</span></h2>
                {c.resolved_at ? <span className="pill sage">Resolved</span>
                  : c.acknowledged_at ? <span className="pill">With {c.acknowledged_by_name}</span>
                  : <span className="pill strong">Waiting {waited(c.age_seconds)}</span>}
                <span className="mode">{when(c.created_at)}</span>
              </div>
              <p className="summary">
                During <strong>{c.title}</strong> ({c.errand_status.replace(/_/g, ' ')}).{' '}
                <Link href={`/users/${c.raised_by}`}>Open their profile</Link>
                {can(who, 'ledger.read') && <> · <Link href={`/errands/${c.errand_id}`}>Errand trace</Link></>}
                {c.lat !== null && c.lng !== null && (
                  <> · Reported at <a href={`https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}#map=17/${c.lat}/${c.lng}`} target="_blank" rel="noreferrer noopener">{c.lat.toFixed(5)}, {c.lng.toFixed(5)}</a></>
                )}
              </p>
              {c.resolved_at
                ? <p className="note">Resolved by {c.resolved_by_name} {when(c.resolved_at)}: {c.resolution_note}</p>
                : <SosActions id={c.id} acknowledged={!!c.acknowledged_at} />}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
