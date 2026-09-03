'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { UserRole } from '@/lib/types';
import { ROLE_LABELS, can, type Capability } from '@/lib/capabilities';

interface NavItem {
  href: string;
  label: string;
  hint: string;
  /**
   * The capability a person needs before this destination is worth showing.
   *
   * Hiding a link is a courtesy, not a control — Row Level Security is what
   * actually stops the request. But a menu full of pages that answer "you may
   * not see this" is a menu nobody trusts, so the two are kept in step.
   */
  needs?: Capability;
}

const NAV: NavItem[] = [
  // A scoped reader — a project manager, a department lead — sees their own
  // projects and the money attributed to them, and the pages that show only
  // company-wide figures are not offered to them at all.
  { href: '/', label: 'CEO home', hint: 'Cash, runway, break-even', needs: 'see_all_money' },
  { href: '/transactions', label: 'Transactions', hint: 'Every dollar, drillable' },
  { href: '/explain', label: 'What changed', hint: 'Where cash went, who moved', needs: 'see_all_money' },
  { href: '/accounts', label: 'Accounts', hint: 'Balances by account and entity', needs: 'see_all_money' },
  { href: '/reconcile', label: 'Reconcile', hint: 'Duplicates and missing categories', needs: 'categorise' },
  { href: '/import', label: 'Import CSV', hint: 'VN bank, VEEM, payroll', needs: 'categorise' },
  { href: '/projects', label: 'Projects', hint: 'Project and event P&L' },
  { href: '/obligations', label: 'Owed & owing', hint: 'Receivables, bills, cash after them' },
  { href: '/budgets', label: 'Budgets', hint: 'Plan vs. actual, and the pace' },
  { href: '/simulator', label: 'Growth & margin', hint: 'Targets and scenarios', needs: 'see_all_money' },
  { href: '/people', label: 'People & time', hint: 'Rates and hours on projects', needs: 'manage_people' },
  // No `needs`: logging your own hours is the one thing every role can do,
  // and it is the only page an employee has any use for.
  { href: '/timesheet', label: 'My hours', hint: 'Log time against a project' },
  { href: '/subscriptions', label: 'Recurring', hint: 'Subscriptions and price rises', needs: 'see_all_money' },
  { href: '/alerts', label: 'Alerts', hint: 'Rules and delivery log', needs: 'see_all_money' },
  { href: '/integrations', label: 'Integrations', hint: 'QuickBooks, Plaid, Stripe', needs: 'manage_integrations' },
  { href: '/access', label: 'Who has access', hint: 'Roles, and Slack accounts' },
  { href: '/audit', label: 'Audit log', hint: 'Who changed what', needs: 'read_audit' },
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
        {NAV.filter((item) => !item.needs || can(role, item.needs)).map((item) => {
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
          <span className="faint text-[11px]">{ROLE_LABELS[role]}</span>
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
