import { notFound } from 'next/navigation';
import { api, ApiError, can, officer } from '@/lib/api';
import { VoidCard } from './VoidCard';
import { ksh, label, ref, when, ERRAND_KIND } from '@/lib/format';

interface Trace {
  errand: { id: string; title: string; kind: string; status: string; spend_cap_cents: number; spent_cents: number;
            agreed_fee_cents: number | null; bonus_cents: number; requester_id: string; runner_id: string | null };
  card: { id: string; last4: string | null; loaded_cents: number; voided_at: string | null } | null;
  escrow: { funded_cents: number; held_cents: number; frozen_at: string | null; released_at: string | null } | null;
  postings: { group_id: string; reason: string; created_at: string; account: string; owner_id: string | null; amount_cents: number; fund_class: string }[];
  tranches: { id: string; seq: number; amount_cents: number; status: string; created_at: string; reimbursement_confirmed: boolean }[];
  attempts: { id: string; tranche_id: string; rung: string; result: string; provider_code: string | null; provider_ref: string | null; created_at: string }[];
  payments: { id: string; rail: string; direction: string; amount_cents: number; status: string; provider_ref: string | null; created_at: string }[];
}

interface Line { at: string; kind: string; what: React.ReactNode; amount: number | null; reference: string | null; sub?: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Where is the money", in one screen (05 §5.6): every posting, tranche, card attempt and rail
// payment for one errand, in the order they happened. Opening it writes an audit row.
export default async function ErrandTrace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  let t: Trace;
  try { t = await api.get<Trace>(`/ops/errands/${id}/trace`); } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const e = t.errand;
  const who = await officer();
  const party = (owner: string | null) => (owner === null ? 'platform' : owner === e.requester_id ? 'requester' : owner === e.runner_id ? 'runner' : 'other');
  const trancheSeq = new Map(t.tranches.map((x) => [x.id, x.seq]));

  const lines: Line[] = [];
  const groups = new Map<string, Trace['postings']>();
  for (const p of t.postings) groups.set(p.group_id, [...(groups.get(p.group_id) ?? []), p]);
  for (const [gid, ps] of groups) {
    lines.push({ at: ps[0]!.created_at, kind: 'Posting', what: ps[0]!.reason.replace(/_/g, ' '), amount: null, reference: gid.slice(0, 8) });
    for (const p of ps) {
      lines.push({ at: p.created_at, kind: '', sub: true, what: `${p.account} · ${party(p.owner_id)} · ${p.fund_class}`, amount: p.amount_cents, reference: null });
    }
  }
  for (const x of t.tranches) {
    lines.push({ at: x.created_at, kind: 'Tranche', what: `#${x.seq} · ${x.status}${x.reimbursement_confirmed ? ' · reimbursement confirmed' : ''}`, amount: x.amount_cents, reference: x.id.slice(0, 8) });
  }
  for (const a of t.attempts) {
    lines.push({ at: a.created_at, kind: 'Attempt', what: `tranche #${trancheSeq.get(a.tranche_id) ?? '?'} · ${a.rung.replace(/_/g, ' ')} · ${a.result}${a.provider_code ? ` (${a.provider_code})` : ''}`, amount: null, reference: a.provider_ref });
  }
  for (const p of t.payments) {
    lines.push({ at: p.created_at, kind: 'Payment', what: `${p.rail} ${p.direction} · ${p.status}`, amount: p.amount_cents, reference: p.provider_ref });
  }
  // Stable: a group's header sorts before its entries, which share its timestamp.
  const ordered = lines.map((l, i) => ({ l, i })).sort((a, b) => a.l.at.localeCompare(b.l.at) || a.i - b.i).map((x) => x.l);

  return (
    <>
      <h1>{e.title}</h1>
      <p className="lede">{ref('ERR', e.id)} · {label(ERRAND_KIND, e.kind)} · {e.status.replace(/_/g, ' ')}</p>
      <div className="grid3">
        <div className="tile"><div className="k">Spend</div><div className="v">KSh {ksh(e.spent_cents)} of KSh {ksh(e.spend_cap_cents)} cap</div></div>
        <div className="tile"><div className="k">Escrow</div><div className="v">
          {t.escrow ? `KSh ${ksh(t.escrow.held_cents)} held of KSh ${ksh(t.escrow.funded_cents)} funded${t.escrow.frozen_at ? ' · frozen' : ''}${t.escrow.released_at ? ' · released' : ''}` : 'Not funded'}
        </div></div>
        <div className="tile"><div className="k">Card</div><div className="v">
          {t.card ? `••${t.card.last4 ?? '––'} · KSh ${ksh(t.card.loaded_cents)} loaded${t.card.voided_at ? ` · voided ${when(t.card.voided_at)}` : ''}` : 'No card issued'}
          {t.card && !t.card.voided_at && can(who, 'legal_ops') && <div className="tile-action"><VoidCard errandId={e.id} cardId={t.card.id} /></div>}
        </div></div>
      </div>
      <div className="eyebrow">Everything that moved, in order</div>
      {ordered.length === 0 ? <p className="empty">No money has moved on this errand.</p> : (
        <table className="table">
          <thead><tr><th scope="col">When</th><th scope="col">Kind</th><th scope="col">What</th><th scope="col" className="num">Amount</th><th scope="col">Provider / ref</th></tr></thead>
          <tbody>
            {ordered.map((l, i) => (
              <tr key={i}>
                <td className="muted">{l.sub ? '' : when(l.at)}</td>
                <td>{l.kind}</td>
                <td className={l.sub ? 'mono' : undefined}>{l.what}</td>
                <td className="num">{l.amount === null ? '' : `${l.amount < 0 ? '−' : ''}KSh ${ksh(Math.abs(l.amount))}`}</td>
                <td className="mono">{l.reference ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="fine">Postings in each group sum to zero. A positive amount is value arriving in the account named; negative is value leaving it.</p>
    </>
  );
}
