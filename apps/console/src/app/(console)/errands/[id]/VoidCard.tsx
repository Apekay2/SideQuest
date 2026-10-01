'use client';

import { useState, useTransition } from 'react';
import { voidCard } from './actions';

// Destructive: the runner's card stops working mid-errand. Two steps, and Cancel is the default.
export function VoidCard({ errandId, cardId }: { errandId: string; cardId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (done) return <p className="note" role="status">Void requested. The card stops working as soon as the issuer confirms; the trace updates then.</p>;
  if (!confirming) return <button className="btn sm quiet" onClick={() => setConfirming(true)}>Void card…</button>;
  return (
    <div className="warn stack" role="alertdialog" aria-label="Void this card?">
      <span>Void this card now? The runner can't pay at any stall after this. Use it for fraud or a lost phone, not a dispute (a dispute voids the card itself).</span>
      <span className="row">
        <button className="btn sm outline" onClick={() => setConfirming(false)} autoFocus>Cancel</button>
        <button className="btn sm terracotta" disabled={pending} onClick={() => start(async () => {
          const r = await voidCard(errandId, cardId);
          if (r.ok) setDone(true); else setError(r.error ?? 'Could not void the card');
        })}>{pending ? 'Voiding…' : 'Void card'}</button>
      </span>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
