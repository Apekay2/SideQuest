'use client';

import { useActionState } from 'react';
import { signIn, type SignInState } from './actions';

export function SignInForm({ expired }: { expired: boolean }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, { step: 'phone' });
  return (
    <form action={action} aria-describedby="signin-note">
      <h1>Side Qwest Ops</h1>
      <p id="signin-note" className="lede">
        Restricted console. Access limited to the system administrator; every view is access-logged.
      </p>
      {expired && state.step === 'phone' && !state.error && <p className="warn" role="status">Your session ended. Sign in again.</p>}
      {state.step === 'phone' ? (
        <label className="field">Staff phone number
          <input name="msisdn" type="tel" inputMode="tel" autoComplete="tel" required defaultValue={state.msisdn} autoFocus />
        </label>
      ) : (
        <label className="field">6-digit code sent to {state.msisdn}
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
        </label>
      )}
      {state.error && <p className="warn" role="alert">{state.error}</p>}
      <button className="btn terracotta display" type="submit" disabled={pending}>
        {pending ? 'One moment…' : state.step === 'phone' ? 'Send code' : 'Sign in'}
      </button>
    </form>
  );
}
