import Link from 'next/link';
import { ref, waited, ksh, label, DISPUTE_REASON, ERRAND_KIND } from '@/lib/format';

export interface DisputeRow { id: string; reason: string; kind: string; age_seconds: number; held_cents: number | null }

export function DisputeList({ rows, current }: { rows: DisputeRow[]; current?: string }) {
  return (
    <div className="cases">
      <h1>Disputes</h1>
      <p className="lede">Escrow frozen, card voided. Oldest first.</p>
      {rows.length === 0 ? <p className="empty">No disputes waiting on a ruling.</p> : (
        <div className="case-list">
          {rows.map((c) => (
            <Link key={c.id} href={`/disputes/${c.id}`} className="case" aria-current={c.id === current ? 'page' : undefined}>
              <div className="top">
                <span className="ref">{ref('DSP', c.id)}</span>
                {c.held_cents !== null && <span className="amt">KSh {ksh(c.held_cents)}</span>}
              </div>
              <div className="why">{label(DISPUTE_REASON, c.reason)}</div>
              <div className="meta">{waited(c.age_seconds)} · {label(ERRAND_KIND, c.kind)}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
