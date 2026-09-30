'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { OUTCOMES, MIN_RATIONALE, check, preset, toCents, type Outcome } from '@/lib/split';
import { ksh } from '@/lib/format';
import { rule } from './actions';

// The split arithmetic is shown live, before submission (05 §5.6): what each side gets, and
// whether that adds up to exactly what escrow holds.
export function RulingForm({ disputeId, held, hasRunner }: { disputeId: string; held: number; hasRunner: boolean }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [requester, setRequester] = useState('');
  const [runner, setRunner] = useState('');
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const choose = (o: Outcome) => {
    const p = preset(o, held, hasRunner);
    setOutcome(o);
    setRequester(ksh(p.requester).replace(/,/g, ''));
    setRunner(ksh(p.runner).replace(/,/g, ''));
  };
  const req = toCents(requester || '0');
  const run = toCents(runner || '0');
  const c = check({ outcome, requester: req, runner: run, rationale }, held, hasRunner);
  const sumOk = Number.isFinite(req) && Number.isFinite(run) && c.remainder === 0;

  const submit = () => start(async () => {
    setError(null);
    const r = await rule(disputeId, { outcome: outcome!, requester_cents: req, runner_cents: run, rationale: rationale.trim() });
    if (!r.ok) { setError(r.error ?? 'The ruling was not recorded'); return; }
    setDone(`Ruled: KSh ${ksh(req)} to the requester, KSh ${ksh(run)} to the runner. The ledger posts it next; both parties are notified with your reasoning.`);
    router.refresh();
  });

  if (done) return <div className="note" role="status">{done}</div>;

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (c.ok) submit(); }}>
      <div className="row" role="group" aria-label="Ruling">
        {OUTCOMES.map((o) => (
          <button key={o.value} type="button" aria-pressed={outcome === o.value}
                  className={`btn ${o.tone}${o.tone === 'sage' || o.tone === 'terracotta' ? ' display' : ''}`}
                  disabled={o.value === 'runner_favour' && !hasRunner}
                  onClick={() => choose(o.value)}>{o.label}</button>
        ))}
      </div>
      {outcome && (
        <>
          <div className="amounts">
            <label className="field">To the requester (KSh)
              <input inputMode="decimal" value={requester} onChange={(e) => setRequester(e.target.value)} />
            </label>
            <label className="field">To the runner (KSh)
              <input inputMode="decimal" value={runner} onChange={(e) => setRunner(e.target.value)} disabled={!hasRunner} />
            </label>
            <span className={`sum ${sumOk ? 'ok' : 'bad'}`} aria-live="polite">
              {Number.isFinite(req) && Number.isFinite(run)
                ? `KSh ${ksh(req)} + KSh ${ksh(run)} = KSh ${ksh(req + run)} of KSh ${ksh(held)} ${sumOk ? '✓' : '✗'}`
                : 'Amounts must be plain shillings'}
            </span>
          </div>
          <label className="field">
            Rationale — cite the evidence above. Both parties read this.
            <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={4000}
                      aria-describedby="rationale-count" />
          </label>
          <span id="rationale-count" className="count-line">{rationale.trim().length} / {MIN_RATIONALE} characters minimum</span>
          {c.problems.length > 0 && <ul className="problems">{c.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          <div className="row">
            <button className="btn terracotta display" type="submit" disabled={!c.ok || pending}>
              {pending ? 'Recording…' : 'Record ruling'}
            </button>
          </div>
        </>
      )}
      {error && <p className="warn" role="alert">{error}</p>}
    </form>
  );
}
