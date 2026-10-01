'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem { href: string; label: string; count?: number | null; exact?: boolean; urgent?: boolean }

export function NavLinks({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Console">
      {items.map((i) => (
        <Link key={i.href} href={i.href} className={i.urgent ? 'urgent' : undefined}
              aria-current={path === i.href || (!i.exact && path.startsWith(`${i.href}/`)) ? 'page' : undefined}>
          {i.label}
          {typeof i.count === 'number' && <span className="count">· {i.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
