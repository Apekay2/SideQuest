import Link from 'next/link';
import { api } from '@/lib/api';
import { ksh, label, ref, when, DISPUTE_REASON } from '@/lib/format';
import { OUTCOME_LABEL, type Outcome } from '@/lib/split';

interface Row {
  id: string; dispute_id: string; officer_name: string; outcome: Outcome; requester_cents: number; runner_cents: number;
  rationale: string; created_at: string; reason: string;
}

const TONE: Record<Outcome, string> = { runner_favour: 'sage', requester_favour: 'strong', split: '', void: 'sand' };

export default async function Rulings() {
  const { data } = await api.get<{ data: Row[] }>('/ops/rulings');
  return (
    <>
      <h1>Rulings log</h1>
      <p className="lede">Append-only. Entries cannot be edited or removed; a correction is a new entry citing the first.</p>
      {data.length === 0 ? <p className="empty">No rulings yet.</p> : (
        <table className="table">
          <thead><tr>
            <th scope="col">When</th><th scope="col">Case</th><th scope="col">Ruling</th>
            <th scope="col">Rested on</th><th scope="col" className="num">Split</th><th scope="col">Reviewer</th>
          </tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td className="muted nowrap">{when(r.created_at)}</td>
                <td className="nowrap"><Link href={`/disputes/${r.dispute_id}`}>{ref('DSP', r.dispute_id)}</Link></td>
                <td><span className={`pill ${TONE[r.outcome]}`}>{OUTCOME_LABEL[r.outcome]}</span></td>
                <td className="muted" title={r.rationale}>
                  {label(DISPUTE_REASON, r.reason)} — {r.rationale.length > 90 ? `${r.rationale.slice(0, 90)}…` : r.rationale}
                </td>
                <td className="num">KSh {ksh(r.requester_cents)} / {ksh(r.runner_cents)}</td>
                <td className="muted">{r.officer_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
