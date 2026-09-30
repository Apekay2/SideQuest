import Link from 'next/link';
import { api, can, officer, tryGet } from '@/lib/api';
import { ksh, label, ref, when, DISPUTE_REASON, ERRAND_KIND } from '@/lib/format';
import { DisputeList, type DisputeRow } from '../DisputeList';
import { RulingForm } from '../RulingForm';
import { Photo } from '../../Photo';

interface Pack {
  dispute: { id: string; errand_id: string; reason: string; detail: string | null; raised_by: string; status: string; created_at: string };
  errand: { id: string; title: string; kind: string; status: string; requester_id: string; runner_id: string | null;
            spend_cap_cents: number; spent_cents: number; agreed_fee_cents: number | null; bonus_cents: number; handover_at: string | null };
  escrow_cents: number | null;
  stalls: { id: string; seq: number; name: string; status: string; total_cents: number }[];
  messages: { sender_id: string; body: string; created_at: string }[];
  evidence: { id: string; stall_id: string | null; kind: string; attempt: number; rejected: boolean; taken_at: string; url: string }[];
}

export default async function Dispute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const who = await officer();
  const [{ data: rows }, pack] = await Promise.all([
    api.get<{ data: DisputeRow[] }>('/ops/disputes'),
    // Reading the pack writes a dispute.evidence_view audit row at the API.
    tryGet<Pack>(`/ops/disputes/${encodeURIComponent(id)}/evidence`),
  ]);

  return (
    <div className="split">
      <DisputeList rows={rows} current={id} />
      <section className="panel" aria-labelledby="case-ref">
        {!pack ? (
          <>
            <h2 id="case-ref">{ref('DSP', id)}</h2>
            <p className="summary">Opening the evidence pack needs the evidence.view entitlement.</p>
          </>
        ) : <Detail pack={pack} canRule={can(who, 'legal_ops')} canTrace={can(who, 'ledger.read')} />}
      </section>
    </div>
  );
}

function Detail({ pack, canRule, canTrace }: { pack: Pack; canRule: boolean; canTrace: boolean }) {
  const { dispute: d, errand: e } = pack;
  const party = (accountId: string) => (accountId === e.requester_id ? 'Requester' : accountId === e.runner_id ? 'Runner' : 'Staff');
  const photos = pack.evidence;
  const rejected = photos.filter((x) => x.rejected).length;
  const approved = pack.stalls.filter((s) => s.status === 'approved' || s.status === 'substituted');
  const stallName = (sid: string | null) => pack.stalls.find((s) => s.id === sid)?.name;
  const ruled = d.status === 'ruled' || d.status === 'closed';

  const tiles = [
    { k: 'Photos', v: photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}${rejected ? ` · ${rejected} rejected` : ''}` : 'No photos taken' },
    { k: 'Stalls', v: pack.stalls.length ? `${approved.length} of ${pack.stalls.length} approved · KSh ${ksh(approved.reduce((a, s) => a + s.total_cents, 0))}` : 'No stalls' },
    { k: 'Spend', v: `KSh ${ksh(e.spent_cents)} of KSh ${ksh(e.spend_cap_cents)} cap` },
    { k: 'Handover', v: e.handover_at ? `Scanned ${when(e.handover_at)}` : 'No scan recorded' },
    { k: 'Messages', v: `${pack.messages.length} message${pack.messages.length === 1 ? '' : 's'}` },
    { k: 'Fee', v: e.agreed_fee_cents !== null ? `KSh ${ksh(e.agreed_fee_cents)}${e.bonus_cents ? ` + KSh ${ksh(e.bonus_cents)} bonus` : ''}` : 'No runner assigned' },
  ];

  return (
    <>
      <div className="panel-head">
        <h2 id="case-ref">{ref('DSP', d.id)}</h2>
        {pack.escrow_cents !== null
          ? <span className="pill">Escrow frozen · KSh {ksh(pack.escrow_cents)}</span>
          : <span className="pill sand">Escrow amount needs ledger.read</span>}
        {ruled && <span className="pill sage">Ruled</span>}
        <span className="mode">{label(ERRAND_KIND, e.kind)} · {e.title}</span>
      </div>
      <p className="summary">
        {party(d.raised_by)} reports <strong>{label(DISPUTE_REASON, d.reason).toLowerCase()}</strong>, {when(d.created_at)}.
        {d.detail && <> In their words: <q>{d.detail}</q></>}
        {canTrace && <> <Link href={`/errands/${e.id}`}>Money trace →</Link></>}
      </p>

      <div className="eyebrow">Evidence pack</div>
      <div className="grid3">
        {tiles.map((t) => <div className="tile" key={t.k}><div className="k">{t.k}</div><div className="v">{t.v}</div></div>)}
      </div>
      {photos.length > 0 && (
        <div className="photos">
          {photos.map((p) => (
            <Photo key={p.id} src={p.url} rejected={p.rejected}
                   caption={`${stallName(p.stall_id) ?? p.kind} · ${when(p.taken_at)}${p.attempt > 1 ? ` · try ${p.attempt}` : ''}${p.rejected ? ' · rejected' : ''}`} />
          ))}
        </div>
      )}
      {pack.messages.length > 0 && (
        <details className="thread">
          <summary>Read the {pack.messages.length} message{pack.messages.length === 1 ? '' : 's'}</summary>
          <ul className="msgs">
            {pack.messages.map((m, i) => <li key={i}><span className="who">{party(m.sender_id)} · {when(m.created_at)}</span>{m.body}</li>)}
          </ul>
        </details>
      )}

      <div className="eyebrow">Ruling</div>
      {ruled ? <p className="muted">This dispute has been ruled. See the <Link href="/rulings">rulings log</Link>.</p>
        : !canRule ? <p className="muted">Ruling needs the legal_ops entitlement.</p>
        : pack.escrow_cents === null ? <p className="muted">Ruling needs ledger.read too, to see what escrow holds.</p>
        : <RulingForm disputeId={d.id} held={pack.escrow_cents} hasRunner={!!e.runner_id} />}
      <p className="fine">Rulings are append-only, cite the evidence above, and bind both parties. Either side may request one review, which routes to a different reviewer.</p>
    </>
  );
}
