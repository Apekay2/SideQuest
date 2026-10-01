import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, can, officer, tryGet } from '@/lib/api';
import { signOut } from '../sign-in/actions';
import { findErrand } from './actions';
import { NavLinks, type NavItem } from './NavLinks';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const who = await officer();
  if (!who) redirect('/sign-in');
  const [me, kyc, disputes] = await Promise.all([
    api.get<{ display_name: string }>('/me'),
    can(who, 'kyc.review') ? tryGet<{ data: unknown[] }>('/ops/kyc') : null,
    can(who, 'ops.read') ? tryGet<{ data: unknown[] }>('/ops/disputes') : null,
  ]);

  // Only what this officer's entitlements open; the API refuses the rest regardless.
  const items: NavItem[] = [
    ...(can(who, 'kyc.review') ? [{ href: '/kyc', label: 'KYC queue', count: kyc?.data.length ?? null }] : []),
    ...(can(who, 'ops.read') ? [{ href: '/disputes', label: 'Disputes', count: disputes?.data.length ?? null }] : []),
    ...(can(who, 'ops.read') ? [{ href: '/rulings', label: 'Rulings log' }] : []),
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
