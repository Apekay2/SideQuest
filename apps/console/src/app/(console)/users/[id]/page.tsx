import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, ApiError, can, officer } from '@/lib/api';
import { ksh, label, when, ERRAND_KIND, ERRAND_STATUS, STAFF_GRANT_LABEL, statusTone } from '@/lib/format';
import { SuspendControl, GrantsControl } from '../AccountActions';

interface Profile {
  id: string; display_name: string; role: string; verification_tier: number; language: string; created_at: string;
  suspended_at: string | null; msisdn_masked: string | null; staff_grants: string[];
  stats: { posted: number; posted_settled: number; ran: number; ran_settled: number; disputes_raised: number; disputes_against: number; sos_raised: number };
  errands: { id: string; title: string; kind: string; status: string; created_at: string; spend_cap_cents: number; spent_cents: number; as_role: string }[];
  kyc_cases: { id: string; target_tier: number; status: string; created_at: string }[] | null;
  audit: { action: string; created_at: string; actor_name: string | null; reason: string | null }[] | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Opening a profile writes an account.view audit row at the API.
export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const who = await officer();
  let p: Profile;
  try { p = await api.get<Profile>(`/ops/accounts/${id}`); } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const self = who?.sub === p.id;
  const s = p.stats;

  return (
    <>
      <p><Link href="/users">← Users</Link></p>
      <div className="title-row">
        <h1>{p.display_name}</h1>
        {p.suspended_at ? <span className="pill strong">Suspended {when(p.suspended_at)}</span> : <span className="pill sage">Active</span>}
      </div>
      <p className="lede">
        {p.role === 'staff' ? 'Staff' : p.role === 'runner' ? 'Runner' : 'Requester'}
        {p.role !== 'staff' && ` · tier ${p.verification_tier}`} · phone {p.msisdn_masked} · {p.language === 'sw' ? 'Swahili' : 'English'} · joined {when(p.created_at)}
      </p>

      {p.role !== 'staff' && (
        <div className="grid4">
          <div className="tile stat"><div className="k">Errands posted</div><div className="hero">{s.posted}</div><div className="v muted">{s.posted_settled} settled</div></div>
          <div className="tile stat"><div className="k">Errands run</div><div className="hero">{s.ran}</div><div className="v muted">{s.ran_settled} settled</div></div>
          <div className="tile stat"><div className="k">Disputes</div><div className="hero">{s.disputes_raised + s.disputes_against}</div><div className="v muted">{s.disputes_raised} raised · {s.disputes_against} against</div></div>
          <div className="tile stat"><div className="k">SOS raised</div><div className={`hero${s.sos_raised ? ' alert' : ''}`}>{s.sos_raised}</div></div>
        </div>
      )}

      <div className="two-col">
        <section>
          {p.role !== 'staff' && (
            <>
              <div className="eyebrow">Recent errands</div>
              {p.errands.length === 0 ? <p className="empty">No errands yet.</p> : (
                <table className="table compact">
                  <thead><tr><th scope="col">Errand</th><th scope="col">As</th><th scope="col">Status</th><th scope="col" className="num">Spent</th></tr></thead>
                  <tbody>
                    {p.errands.map((e) => (
                      <tr key={e.id}>
                        <td>{can(who, 'ledger.read') ? <Link href={`/errands/${e.id}`}>{e.title}</Link> : e.title}<div className="muted small">{label(ERRAND_KIND, e.kind)} · {when(e.created_at)}</div></td>
                        <td>{e.as_role}</td>
                        <td><span className={`pill ${statusTone(e.status)}`}>{label(ERRAND_STATUS, e.status)}</span></td>
                        <td className="num">KSh {ksh(e.spent_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
          {p.kyc_cases && p.kyc_cases.length > 0 && (
            <>
              <div className="eyebrow">KYC cases</div>
              <ul className="list">
                {p.kyc_cases.map((k) => <li key={k.id}><Link href={`/kyc/${k.id}`}>Tier {k.target_tier}</Link> · {k.status.replace('_', ' ')} · {when(k.created_at)}</li>)}
              </ul>
            </>
          )}
          {p.audit && (
            <>
              <div className="eyebrow">Audit trail</div>
              {p.audit.length === 0 ? <p className="muted">Nothing recorded.</p> : (
                <ul className="list">
                  {p.audit.map((a, i) => (
                    <li key={i}><span className="muted nowrap">{when(a.created_at)}</span> · {a.action} by {a.actor_name ?? 'system'}{a.reason ? <> — <q>{a.reason}</q></> : null}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <aside className="stack">
          {can(who, 'accounts.manage') && !self && (
            <div className="panel tight">
              <div className="eyebrow first">Account</div>
              <SuspendControl id={p.id} suspended={!!p.suspended_at} />
            </div>
          )}
          {can(who, 'staff.admin') && !self && !p.suspended_at && (
            <div className="panel tight">
              <div className="eyebrow first">{p.role === 'staff' ? 'Staff access' : 'Make staff'}</div>
              <GrantsControl id={p.id} role={p.role} current={p.staff_grants} />
            </div>
          )}
          {p.role === 'staff' && (!can(who, 'staff.admin') || self) && (
            <div className="panel tight">
              <div className="eyebrow first">Staff access</div>
              {p.staff_grants.length === 0 ? <p className="muted">No access.</p> : (
                <ul className="list">{p.staff_grants.map((g) => <li key={g}>{STAFF_GRANT_LABEL[g] ?? g}</li>)}</ul>
              )}
              {self && <p className="fine">Your own access is changed by another staff admin.</p>}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
