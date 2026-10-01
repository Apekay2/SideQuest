import { api } from '@/lib/api';
import { ksh, label, when, LEDGER_ACCOUNT } from '@/lib/format';

interface Finance {
  balances: { account: string; balance_cents: number }[];
  payouts: { status: string; n: number; cents: number }[];
  payments: { rail: string; direction: string; status: string; n: number; cents: number }[];
  failures: { kind: string; id: string; amount_cents: number; failure_code: string | null; created_at: string; who: string }[];
  reconciliation: { id: number; ran_at: string; checks_run: number; findings: number; paged: number; duration_ms: number }[];
}

const signed = (c: number) => `${c < 0 ? '−' : ''}KSh ${ksh(Math.abs(c))}`;

// Viewing this writes a finance.view audit row at the API.
export default async function FinancePage() {
  const f = await api.get<Finance>('/ops/finance');
  const total = f.balances.reduce((a, b) => a + b.balance_cents, 0);
  return (
    <>
      <h1>Finance</h1>
      <p className="lede">Balances straight from the double-entry ledger, rail activity for the last 30 days, and the nightly reconciliation.</p>

      <div className="two-col">
        <section>
          <div className="eyebrow">Ledger balances</div>
          <table className="table compact">
            <thead><tr><th scope="col">Account</th><th scope="col" className="num">Balance</th></tr></thead>
            <tbody>
              {f.balances.map((b) => <tr key={b.account}><td>{label(LEDGER_ACCOUNT, b.account)}</td><td className="num">{signed(b.balance_cents)}</td></tr>)}
              <tr><td><strong>Sum</strong></td><td className="num"><strong>{signed(total)}</strong> {total === 0 ? <span className="pill sage">balanced</span> : <span className="pill strong">does not balance</span>}</td></tr>
            </tbody>
          </table>
          <p className="fine">Positive is value held in the account. M-Pesa settlement is the boundary with the outside world, so it carries the opposite sign of everything inside.</p>
        </section>
        <section>
          <div className="eyebrow">Payouts, 30 days</div>
          {f.payouts.length === 0 ? <p className="muted">None.</p> : (
            <table className="table compact">
              <thead><tr><th scope="col">Status</th><th scope="col" className="num">Count</th><th scope="col" className="num">Amount</th></tr></thead>
              <tbody>{f.payouts.map((p) => <tr key={p.status}><td>{p.status}</td><td className="num">{p.n}</td><td className="num">KSh {ksh(p.cents)}</td></tr>)}</tbody>
            </table>
          )}
          <div className="eyebrow">Payments, 30 days</div>
          {f.payments.length === 0 ? <p className="muted">None.</p> : (
            <table className="table compact">
              <thead><tr><th scope="col">Rail</th><th scope="col">Status</th><th scope="col" className="num">Count</th><th scope="col" className="num">Amount</th></tr></thead>
              <tbody>{f.payments.map((p, i) => <tr key={i}><td>{p.rail.replace(/_/g, ' ')} {p.direction}</td><td>{p.status}</td><td className="num">{p.n}</td><td className="num">KSh {ksh(p.cents)}</td></tr>)}</tbody>
            </table>
          )}
        </section>
      </div>

      <div className="eyebrow">Recent failures</div>
      {f.failures.length === 0 ? <p className="empty">No failed payouts or payments.</p> : (
        <table className="table">
          <thead><tr><th scope="col">When</th><th scope="col">Kind</th><th scope="col">Who</th><th scope="col" className="num">Amount</th><th scope="col">Reason</th></tr></thead>
          <tbody>{f.failures.map((x) => (
            <tr key={x.id}><td className="muted nowrap">{when(x.created_at)}</td><td>{x.kind}</td><td>{x.who}</td><td className="num">KSh {ksh(x.amount_cents)}</td><td className="mono">{x.failure_code ?? '—'}</td></tr>
          ))}</tbody>
        </table>
      )}

      <div className="eyebrow">Reconciliation</div>
      {f.reconciliation.length === 0 ? <p className="empty">The nightly reconciliation has not run yet. It starts with the worker.</p> : (
        <table className="table">
          <thead><tr><th scope="col">Ran</th><th scope="col" className="num">Checks</th><th scope="col" className="num">Findings</th><th scope="col" className="num">Paged</th><th scope="col" className="num">Took</th></tr></thead>
          <tbody>{f.reconciliation.map((r) => (
            <tr key={r.id}><td className="nowrap">{when(r.ran_at)}</td><td className="num">{r.checks_run}</td>
              <td className="num">{r.findings === 0 ? <span className="pill sage">0</span> : <span className="pill strong">{r.findings}</span>}</td>
              <td className="num">{r.paged}</td><td className="num">{(r.duration_ms / 1000).toFixed(1)} s</td></tr>
          ))}</tbody>
        </table>
      )}
    </>
  );
}
