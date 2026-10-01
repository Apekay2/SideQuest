'use client';

import { useState, useTransition } from 'react';
import { STAFF_GRANT_LABEL } from '@/lib/format';
import { suspend, reinstate, setGrants, makeStaff, type ActionResult } from './actions';

const GRANTS = Object.keys(STAFF_GRANT_LABEL);

function Outcome({ r }: { r: ActionResult | null }) {
  if (!r) return null;
  return r.ok ? <p className="note" role="status">{r.message}</p> : <p className="warn" role="alert">{r.error}</p>;
}

/** Suspend or reinstate. The reason is recorded in the audit trail; the person is told by SMS. */
export function SuspendControl({ id, suspended }: { id: string; suspended: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [r, setR] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const act = () => start(async () => { const out = await (suspended ? reinstate : suspend)(id, reason.trim()); setR(out); if (out.ok) setOpen(false); });

  if (!open) {
    return (
      <div className="stack">
        <span className="row">
          <button className={`btn sm ${suspended ? 'sage' : 'quiet'}`} onClick={() => { setOpen(true); setR(null); }}>
            {suspended ? 'Reinstate account' : 'Suspend account'}
          </button>
        </span>
        <Outcome r={r} />
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); act(); }}>
      <label className="field">
        {suspended ? 'Why is it safe to reinstate?' : 'Why suspend? This goes in the audit trail.'}
        <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={8} maxLength={280} required autoFocus />
      </label>
      {!suspended && <p className="fine">They are signed out everywhere at once and can't sign back in until reinstated.</p>}
      <span className="row">
        <button className={`btn sm ${suspended ? 'sage' : 'terracotta'}`} type="submit" disabled={pending || reason.trim().length < 8}>
          {pending ? 'Working…' : suspended ? 'Reinstate' : 'Suspend'}
        </button>
        <button className="btn sm quiet" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </span>
      <Outcome r={r} />
    </form>
  );
}

/** Staff access as a checklist. For a customer account the same list promotes it to staff. */
export function GrantsControl({ id, role, current }: { id: string; role: string; current: string[] }) {
  const [sel, setSel] = useState<string[]>(current);
  const [confirming, setConfirming] = useState(false);
  const [r, setR] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const isStaff = role === 'staff';
  const changed = isStaff ? [...sel].sort().join() !== [...current].sort().join() : sel.length > 0;
  const toggle = (g: string) => setSel((s) => (s.includes(g) ? s.filter((x) => x !== g) : [...s, g]));
  const save = () => start(async () => {
    const out = await (isStaff ? setGrants : makeStaff)(id, sel);
    setR(out); setConfirming(false);
  });

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (isStaff) save(); else setConfirming(true); }}>
      <fieldset className="grants">
        <legend className="visually-hidden">Staff access</legend>
        {GRANTS.map((g) => (
          <label key={g} className="check">
            <input type="checkbox" checked={sel.includes(g)} onChange={() => toggle(g)} />
            <span>{STAFF_GRANT_LABEL[g]}</span>
          </label>
        ))}
      </fieldset>
      {confirming ? (
        <div className="warn stack">
          <span>Make this a staff account? This is one-way: it stops being a customer account and can only sign in to this console.</span>
          <span className="row">
            <button className="btn sm terracotta" type="button" onClick={save} disabled={pending}>{pending ? 'Working…' : 'Yes, make staff'}</button>
            <button className="btn sm quiet" type="button" onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        </div>
      ) : (
        <span className="row">
          <button className="btn sm sage" type="submit" disabled={pending || !changed}>{isStaff ? 'Save access' : 'Make staff…'}</button>
        </span>
      )}
      <Outcome r={r} />
    </form>
  );
}
