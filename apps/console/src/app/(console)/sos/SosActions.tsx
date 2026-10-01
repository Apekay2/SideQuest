'use client';

import { useState, useTransition } from 'react';
import { handleSos } from './actions';

export function SosActions({ id, acknowledged }: { id: string; acknowledged: boolean }) {
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = (step: 'acknowledge' | 'resolve') => start(async () => {
    setError(null);
    const r = await handleSos(id, step, note.trim());
    if (!r.ok) setError(r.error ?? 'Could not record that');
  });

  return (
    <div className="stack">
      {resolving ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); go('resolve'); }}>
          <label className="field">What happened, and what was done? Both parties' safety record keeps this.
            <textarea value={note} onChange={(e) => setNote(e.target.value)} minLength={4} maxLength={1000} required autoFocus />
          </label>
          <span className="row">
            <button className="btn sm sage" type="submit" disabled={pending || note.trim().length < 4}>{pending ? 'Saving…' : 'Mark resolved'}</button>
            <button className="btn sm quiet" type="button" onClick={() => setResolving(false)}>Cancel</button>
          </span>
        </form>
      ) : (
        <span className="row">
          {!acknowledged && <button className="btn sm terracotta" onClick={() => go('acknowledge')} disabled={pending}>I'm on it</button>}
          <button className="btn sm outline" onClick={() => setResolving(true)}>Resolve…</button>
        </span>
      )}
      {error && <p className="warn" role="alert">{error}</p>}
    </div>
  );
}
