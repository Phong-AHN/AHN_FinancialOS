import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth';
import {
  loadCategories,
  loadTransactions,
  loadTransactionTotals,
  type TransactionFilters,
} from '@/lib/data';
import { loadUsdRates } from '@/lib/fx';
import { usdMinorOf } from '@/lib/calc/engine';
import { categoryLabel } from '@/lib/categorize';
import { formatMoney } from '@/lib/money';
import { today } from '@/lib/dates';
import type { FinancialAccount } from '@/lib/types';
import {
  Badge,
  buttonClass,
  Card,
  EmptyState,
  Money,
  PageHeader,
  ReconBadge,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

const SOURCE_OPTIONS: Array<[string, string]> = [
  ['quickbooks', 'QuickBooks'],
  ['plaid', 'Plaid (bank/cards)'],
  ['stripe', 'Stripe'],
  ['csv_vn_bank', 'CSV — Vietnamese bank'],
  ['csv_veem', 'CSV — VEEM'],
  ['csv_payroll', 'CSV — payroll'],
  ['manual', 'Manual'],
];

/**
 * The drill-down destination for every number on the dashboard (spec 22).
 *
 * Filters live entirely in the URL, which is what makes a dashboard tile able
 * to link to "exactly the rows behind this figure" - and what makes that view
 * shareable in Slack.
 */
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireSession();
  const supabase = createSupabaseServerClient();

  const page = Math.max(1, Number(str(searchParams.page) ?? '1') || 1);
  const filters: TransactionFilters = {
    direction: str(searchParams.direction) as TransactionFilters['direction'],
    accountId: str(searchParams.account),
    category: str(searchParams.category),
    status: str(searchParams.status),
    from: str(searchParams.from),
    to: str(searchParams.to),
    search: str(searchParams.q),
    operatingOnly: str(searchParams.operating) === '1',
    uncategorized: str(searchParams.uncategorized) === '1',
    source: str(searchParams.source),
    excludeDemo: str(searchParams.real) === '1',
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };

  const [{ rows, total }, totals, accountsRes, categories, rates] = await Promise.all([
    loadTransactions(supabase, filters),
    // Across everything the filter matches, not just this page - so a tile that
    // links here is confirmed by what the reader sees, not contradicted by it.
    loadTransactionTotals(supabase, filters),
    supabase.from('financial_accounts').select('*').order('name'),
    loadCategories(supabase),
    loadUsdRates(supabase, today()),
  ]);

  const accounts = (accountsRes.data ?? []) as FinancialAccount[];

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeFilters = describeFilters(filters, accounts);

  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle={
          total === 0
            ? 'Nothing matches these filters.'
            : `${total.toLocaleString('en-US')} transaction${total === 1 ? '' : 's'}${activeFilters ? ` · ${activeFilters}` : ''}`
        }
      />

      {/* ── Filter bar: a plain GET form, so filters stay in the URL ────── */}
      <Card className="mb-4">
        <form method="get" className="grid gap-3 md:grid-cols-4 lg:grid-cols-6">
          <label className="block">
            <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Search</span>
            <input type="search" name="q" defaultValue={filters.search ?? ''} placeholder="Description or note" />
          </label>

          <label className="block">
            <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Direction</span>
            <select name="direction" defaultValue={filters.direction ?? ''}>
              <option value="">Both</option>
              <option value="inflow">Money in</option>
              <option value="outflow">Money out</option>
            </select>
          </label>

          <label className="block">
            <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Account</span>
            <select name="account" defaultValue={filters.accountId ?? ''}>
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Category</span>
            <select name="category" defaultValue={filters.category ?? ''}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Source</span>
            <select name="source" defaultValue={filters.source ?? ''}>
              <option value="">All sources</option>
              {SOURCE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">From</span>
            <input type="date" name="from" defaultValue={filters.from ?? ''} />
          </label>

          <label className="block">
            <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">To</span>
            <input type="date" name="to" defaultValue={filters.to ?? ''} />
          </label>

          <div className="flex items-end gap-4 md:col-span-4 lg:col-span-6">
            <label className="flex items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                name="operating"
                value="1"
                defaultChecked={filters.operatingOnly}
                className="h-4 w-4 accent-[var(--brand)]"
                style={{ width: 16 }}
              />
              Operating only (exclude transfers &amp; duplicates)
            </label>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                name="uncategorized"
                value="1"
                defaultChecked={filters.uncategorized}
                className="h-4 w-4 accent-[var(--brand)]"
                style={{ width: 16 }}
              />
              Missing category only
            </label>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                name="real"
                value="1"
                defaultChecked={filters.excludeDemo}
                className="h-4 w-4 accent-[var(--brand)]"
                style={{ width: 16 }}
              />
              Real money only (hide demo seed)
            </label>
            <div className="ml-auto flex gap-2">
              <Link href="/transactions" className={buttonClass('secondary')}>
                Clear
              </Link>
              <button type="submit" className={buttonClass('primary')}>
                Apply
              </button>
            </div>
          </div>
        </form>
      </Card>

      {rows.length > 0 && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 text-[13px]">
            <span>
              <span className="faint">Money in: </span>
              <Money minor={totals.inflowUsdMinor} direction="inflow" className="font-semibold" />
            </span>
            <span>
              <span className="faint">Money out: </span>
              <Money minor={totals.outflowUsdMinor} direction="outflow" className="font-semibold" />
            </span>
            <span>
              <span className="faint">Net: </span>
              <Money minor={totals.netUsdMinor} className="font-semibold" />
            </span>
            <span className="faint ml-auto text-[12px]">
              {totals.truncated
                ? `first ${totals.count.toLocaleString('en-US')} matching rows`
                : `all ${totals.count.toLocaleString('en-US')} matching rows` +
                  (total > rows.length ? `, showing ${rows.length}` : '')}
            </span>
          </div>
        </Card>
      )}

      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState
            title="No transactions match"
            body="Widen the date range or clear the filters. If nothing appears at all, connect a source or import a CSV first."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Counterparty / description</th>
                <th>Category</th>
                <th>Account</th>
                <th>Source</th>
                <th>Status</th>
                <th className="text-right">Amount</th>
                <th className="text-right">USD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="tabular muted whitespace-nowrap">{t.txn_date}</td>
                  <td>
                    <Link href={`/transactions/${t.id}`} className="font-medium hover:underline">
                      {t.counterparty?.name ?? t.description ?? 'Unknown'}
                    </Link>
                    {t.description && t.counterparty?.name && (
                      <span className="faint mt-0.5 block max-w-[340px] truncate text-[11.5px]">
                        {t.description}
                      </span>
                    )}
                    <span className="mt-1 flex gap-1.5">
                      {t.is_internal_transfer && <Badge>Internal transfer</Badge>}
                      {t.is_subscription && <Badge tone="brand">Subscription</Badge>}
                    </span>
                  </td>
                  <td className="muted">{categoryLabel(t.category)}</td>
                  <td className="muted">{t.account?.name ?? '—'}</td>
                  <td className="muted capitalize">{t.source_system.replace(/_/g, ' ')}</td>
                  <td>
                    <ReconBadge status={t.reconciliation_status} />
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <Money minor={t.amount_minor} currency={t.currency} direction={t.direction} />
                  </td>
                  <td className="tabular muted whitespace-nowrap text-right">
                    {t.currency === 'USD' ? '—' : formatMoney(usdMinorOf(t, rates))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {pageCount > 1 && (
        <nav className="mt-4 flex items-center justify-between text-[12.5px]">
          <span className="faint">
            Page {page} of {pageCount}
          </span>
          <span className="flex gap-2">
            {page > 1 && (
              <Link href={pageUrl(searchParams, page - 1)} className={buttonClass('secondary')}>
                Previous
              </Link>
            )}
            {page < pageCount && (
              <Link href={pageUrl(searchParams, page + 1)} className={buttonClass('secondary')}>
                Next
              </Link>
            )}
          </span>
        </nav>
      )}
    </>
  );
}

function str(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0] || undefined;
  return value || undefined;
}

function pageUrl(
  searchParams: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    const v = str(value);
    if (v && key !== 'page') params.set(key, v);
  }
  params.set('page', String(page));
  return `/transactions?${params.toString()}`;
}

function describeFilters(filters: TransactionFilters, accounts: FinancialAccount[]): string {
  const parts: string[] = [];
  if (filters.direction) parts.push(filters.direction === 'inflow' ? 'money in' : 'money out');
  if (filters.accountId) {
    parts.push(accounts.find((a) => a.id === filters.accountId)?.name ?? 'one account');
  }
  if (filters.category) parts.push(categoryLabel(filters.category));
  if (filters.from || filters.to) parts.push(`${filters.from ?? 'start'} → ${filters.to ?? 'today'}`);
  if (filters.source) {
    parts.push(SOURCE_OPTIONS.find(([v]) => v === filters.source)?.[1] ?? filters.source);
  }
  if (filters.excludeDemo) parts.push('real money only');
  if (filters.operatingOnly) parts.push('operating only');
  if (filters.uncategorized) parts.push('missing category');
  if (filters.search) parts.push(`matching "${filters.search}"`);
  return parts.join(' · ');
}
