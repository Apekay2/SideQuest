import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, can, officer, tryGet } from '@/lib/api';
import { signOut } from '../sign-in/actions';
import { findErrand } from './actions';
import { NavLinks, type NavItem } from './NavLinks';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const who = await officer();
  if (!who) redirect('/sign-in');
  const [me, kyc, disputes, sos] = await Promise.all([
    api.get<{ display_name: string }>('/me'),
    can(who, 'kyc.review') ? tryGet<{ data: unknown[] }>('/ops/kyc') : null,
    can(who, 'ops.read') ? tryGet<{ data: unknown[] }>('/ops/disputes') : null,
    can(who, 'ops.read') ? tryGet<{ data: unknown[] }>('/ops/sos') : null,
  ]);

  // Only what this officer's entitlements open; the API refuses the rest regardless.
  const ops = can(who, 'ops.read');
  const items: NavItem[] = [
    ...(ops ? [{ href: '/', label: 'Overview', exact: true }] : []),
    ...(ops ? [{ href: '/sos', label: 'SOS', count: sos?.data.length ?? null, urgent: (sos?.data.length ?? 0) > 0 }] : []),
    ...(ops ? [{ href: '/disputes', label: 'Disputes', count: disputes?.data.length ?? null }] : []),
    ...(can(who, 'kyc.review') ? [{ href: '/kyc', label: 'KYC queue', count: kyc?.data.length ?? null }] : []),
    ...(ops ? [{ href: '/errands', label: 'Errands' }] : []),
    ...(ops ? [{ href: '/users', label: 'Users' }] : []),
    ...(can(who, 'ledger.read') ? [{ href: '/finance', label: 'Finance' }] : []),
    ...(ops ? [{ href: '/rulings', label: 'Rulings log' }] : []),
  ];

  return (
    <div className="shell">
      <aside className="rail">
        <Link href="/" className="brand">Side Qwest Ops</Link>
        <NavLinks items={items} />
        {can(who, 'ledger.read') && (
          <form action={findErrand} className="find" role="search">
            <label htmlFor="errand">Money trace</label>
            <input id="errand" name="errand" placeholder="Errand id" autoComplete="off" spellCheck={false} />
          </form>
        )}
        <div className="rail-foot">
          <span>Restricted console. Access limited to the system administrator; every view is access-logged.</span>
          <span className="who">Signed in as {me.display_name}</span>
          <form action={signOut}><button className="linkish" type="submit">Sign out</button></form>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
