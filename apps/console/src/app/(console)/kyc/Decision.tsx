'use client';

import { useState, useTransition } from 'react';
import { decide } from './actions';

// "Clear tier N" or "Ask again". Asking again is a rejection the applicant reads, so it needs
// a reason in words they can act on; the API refuses one without.
export function Decision({ caseId, tier, align = 'end' }: { caseId: string; tier: number; align?: 'end' | 'start' }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (approve: boolean) => start(async () => {
    setError(null);
    const r = await decide(caseId, approve, approve ? undefined : reason.trim());
    if (r.ok) setDone(r.status!); else setError(r.error ?? 'Could not record the decision');
  });

  if (done) return <span className={`pill ${done === 'approved' ? 'sage' : 'strong'}`} role="status">{done === 'approved' ? `Cleared tier ${tier}` : 'Asked again'}</span>;

  return (
    <div className={`stack ${align === 'end' ? 'right' : ''}`}>
      {!asking ? (
        <span className="row">
          <button className="btn sm sage" disabled={pending} onClick={() => run(true)}>Clear tier {tier}</button>
          <button className="btn sm quiet" disabled={pending} onClick={() => setAsking(true)}>Ask again</button>
        </span>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); run(false); }}>
          <label className="field">What should they send again? They will read this.
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={280} required minLength={8}
                   placeholder="e.g. The back of your ID is blurred — retake it in daylight" autoFocus />
          </label>
          <span className="row">
            <button className="btn sm terracotta" type="submit" disabled={pending || reason.trim().length < 8}>Send back</button>
            <button className="btn sm quiet" type="button" onClick={() => setAsking(false)}>Cancel</button>
          </span>
        </form>
      )}
      {error && <span className="warn" role="alert">{error}</span>}
    </div>
  );
}
