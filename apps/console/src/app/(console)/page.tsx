import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, can, officer } from '@/lib/api';
import { ksh, when } from '@/lib/format';
import { DailyBars } from './DailyBars';

interface Overview {
  counts: { disputes_open: number; sos_open: number; errands_live: number; errands_24h: number; settled_7d: number;
            gmv_7d_cents: number; active_runners_7d: number; signups_7d: number; kyc_waiting: number | null };
  series: { day: string; created: number; settled: number; gmv_cents: number }[];
  money: null | { revenue_7d_cents: number; revenue_30d_cents: number; escrow_held_cents: number; payouts_failed_7d: number;
                  payouts_pending: number; last_reconciliation: { ran_at: string; findings: number; paged: number } | null };
}

function Tile({ k, v, href, alert }: { k: string; v: string | number; href?: string; alert?: boolean }) {
  const body = <><div className="k">{k}</div><div className={`hero${alert ? ' alert' : ''}`}>{v}</div></>;
  return href ? <Link href={href} className="tile stat">{body}</Link> : <div className="tile stat">{body}</div>;
}

export default async function OverviewPage() {
  const who = await officer();
  if (!can(who, 'ops.read')) {
    if (can(who, 'kyc.review')) redirect('/kyc');
    return (
      <>
        <h1>Side Qwest Ops</h1>
        <p className="lede">Your account has no operations access. Use the queues in the menu, or ask a staff admin for the access your role needs.</p>
      </>
    );
  }
  const o = await api.get<Overview>('/ops/overview');
  const c = o.counts;
  return (
    <>
      <h1>Overview</h1>
      <p className="lede">What needs a person now, and how the week is going.</p>

      <div className="eyebrow">Needs attention</div>
      <div className="grid4">
        <Tile k="Open SOS" v={c.sos_open} href="/sos" alert={c.sos_open > 0} />
        <Tile k="Disputes waiting" v={c.disputes_open} href="/disputes" />
        <Tile k="KYC waiting" v={c.kyc_waiting ?? '—'} href={c.kyc_waiting === null ? undefined : '/kyc'} />
        <Tile k="Errands live now" v={c.errands_live} href="/errands" />
      </div>

      <div className="eyebrow">Last 7 days</div>
      <div className="grid4">
        <Tile k="Errands settled" v={c.settled_7d} />
        <Tile k="Goods bought (GMV)" v={`KSh ${ksh(c.gmv_7d_cents)}`} />
        <Tile k="Active runners" v={c.active_runners_7d} />
        <Tile k="New customers" v={c.signups_7d} />
      </div>

      {o.money && (
        <>
          <div className="eyebrow">Money</div>
          <div className="grid4">
            <Tile k="Fee revenue, 7 days" v={`KSh ${ksh(o.money.revenue_7d_cents)}`} href="/finance" />
            <Tile k="Fee revenue, 30 days" v={`KSh ${ksh(o.money.revenue_30d_cents)}`} href="/finance" />
            <Tile k="Held in escrow" v={`KSh ${ksh(o.money.escrow_held_cents)}`} href="/finance" />
            <Tile k="Payouts failed, 7 days" v={o.money.payouts_failed_7d} href="/finance" alert={o.money.payouts_failed_7d > 0} />
          </div>
          <p className="fine">
            {o.money.last_reconciliation
              ? <>Last reconciliation {when(o.money.last_reconciliation.ran_at)}: {o.money.last_reconciliation.findings} finding{o.money.last_reconciliation.findings === 1 ? '' : 's'}.</>
              : <>No reconciliation has run yet.</>}
            {' '}{o.money.payouts_pending} payout{o.money.payouts_pending === 1 ? '' : 's'} in flight.
          </p>
        </>
      )}

      <div className="eyebrow">Errands created per day</div>
      <div className="panel">
        <DailyBars days={o.series.map((d) => ({ day: d.day, value: d.created }))} label="Errands created" />
      </div>
    </>
  );
}
