'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { UserRole } from '@/lib/types';

interface NavItem {
  href: string;
  label: string;
  hint: string;
  ownerOnly?: boolean;
}

const NAV: NavItem[] = [
  { href: '/', label: 'CEO home', hint: 'Cash, runway, break-even' },
  { href: '/transactions', label: 'Transactions', hint: 'Every dollar, drillable' },
  { href: '/accounts', label: 'Accounts', hint: 'Balances by account and entity' },
  { href: '/reconcile', label: 'Reconcile', hint: 'Duplicates and missing categories' },
  { href: '/import', label: 'Import CSV', hint: 'VN bank, VEEM, payroll', ownerOnly: true },
  { href: '/subscriptions', label: 'Recurring', hint: 'Subscriptions and price rises' },
  { href: '/alerts', label: 'Alerts', hint: 'Rules and delivery log' },
  { href: '/integrations', label: 'Integrations', hint: 'QuickBooks, Plaid, Stripe', ownerOnly: true },
  { href: '/audit', label: 'Audit log', hint: 'Who changed what', ownerOnly: true },
];

export function Sidebar({
  role,
  email,
  pendingReview,
}: {
  role: UserRole;
  email: string;
  pendingReview: number;
}) {
  const pathname = usePathname();

  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--surface)]">
      <div className="border-b border-[var(--line)] px-5 py-4">
        <p className="text-[14px] font-semibold tracking-tight">AHN Financial OS</p>
        <p className="faint mt-0.5 text-[11px]">Every dollar in. Every dollar out.</p>
      </div>

      <nav className="flex-1 overflow-y-auto p-2.5">
        {NAV.filter((item) => !item.ownerOnly || role === 'owner').map((item) => {
          const active =
            item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="mb-0.5 block rounded-lg px-3 py-2 transition-colors"
              style={{
                background: active ? 'var(--brand-soft)' : 'transparent',
                color: active ? 'var(--brand)' : 'var(--text)',
              }}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{item.label}</span>
                {item.href === '/reconcile' && pendingReview > 0 && (
                  <span
                    className="tabular rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}
                  >
                    {pendingReview}
                  </span>
                )}
              </span>
              <span
                className="mt-0.5 block text-[11px] leading-tight"
                style={{ color: active ? 'var(--brand)' : 'var(--text-faint)' }}
              >
                {item.hint}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-[var(--line)] px-5 py-3.5">
        <p className="truncate text-[12px] font-medium" title={email}>
          {email}
        </p>
        <div className="mt-1 flex items-center justify-between">
          <span className="faint text-[11px] capitalize">{role}</span>
          <form action="/api/auth/signout" method="post">
            <button type="submit" className="faint text-[11px] underline underline-offset-2">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
