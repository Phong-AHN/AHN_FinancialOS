import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth';
import { loadDashboard } from '@/lib/data';
import { computeCashTrend } from '@/lib/calc/engine';
import { buildNeedsAttention } from '@/lib/alerts/engine';
import { formatMoney, formatMonths, formatPercent } from '@/lib/money';
import { currentMonthRange, formatMonthLabel, monthStart, today } from '@/lib/dates';
import { categoryLabel } from '@/lib/categorize';
import { CashTrend } from '@/components/CashTrend';
import { SyncButton } from '@/components/SyncButton';
import {
  Callout,
  Card,
  EmptyState,
  FormulaNote,
  LinkButton,
  Money,
  PageHeader,
  SectionHeader,
  StatTile,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The CEO home screen - Spec section 21.
 *
 * Every tile answers one of the seven questions the spec says the dashboard has
 * to answer on sight, and every tile is a link: spec section 22 requires each
 * number to drill down to the transactions behind it.
 */
export default async function HomePage() {
  const session = await requireSession();
  const supabase = createSupabaseServerClient();
  const asOf = today();
  const { snapshot, transactions, accounts } = await loadDashboard(supabase, asOf);

  const { cash, breakEven, burn, runway, monthToDate, previousMonth } = snapshot;
  const month = currentMonthRange(asOf);
  // Drill-down links end at TODAY, not at month end. The month-to-date tiles are
  // computed through today, so linking to the whole month would land the reader
  // on a larger figure the moment a future-dated row exists - a scheduled bill
  // or a post-dated deposit out of QuickBooks is enough. A drill-down that
  // disagrees with the tile it came from teaches the reader to distrust both.
  const trend = computeCashTrend(cash.totalUsdMinor, transactions, accounts, asOf, 30);
  const attention = buildNeedsAttention(snapshot, transactions);
  const recent = transactions.slice(0, 8);

  // Tone follows the HEADLINE figure, which is gross runway while cash-positive.
  // Colouring on net runway would paint a company with 3.5 months of cash green
  // simply because last quarter's revenue happened to cover it.
  const headline = runway.headlineMonths;
  const runwayTone =
    headline === null ? 'neutral' : headline < 6 ? 'outflow' : headline < 12 ? 'warn' : 'neutral';

  return (
    <>
      <PageHeader
        title={`Good ${greeting()}, ${session.user.full_name?.split(' ')[0] ?? 'there'}`}
        subtitle={`Position as of ${formatMonthLabel(asOf)} — ${monthToDate.txnCount} transactions this month across ${cash.byAccount.length} accounts.`}
        action={<SyncButton />}
      />

      {attention.length > 0 && (
        <div className="mb-6">
          <Callout tone={headline !== null && headline < 6 ? 'outflow' : 'warn'} title="Needs attention right now">
            <ul className="mt-1 space-y-1">
              {attention.map((item) => (
                <li key={item}>· {item}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}

      {/* ── The four headline questions ─────────────────────────────────── */}
      <div className="mb-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Cash on hand"
          value={formatMoney(cash.totalUsdMinor)}
          hint={`Across ${cash.byAccount.filter((a) => a.account.include_in_cash).length} accounts${cash.byCurrency.length > 1 ? `, ${cash.byCurrency.length} currencies` : ''}`}
          href="/accounts"
          emphasis
        />
        <StatTile
          label={runway.cashPositive ? 'Runway if revenue stopped' : 'Runway'}
          value={formatMonths(headline)}
          hint={
            runway.cashPositive
              ? `Cash-positive right now — this is the stress case, on ${formatMoney(burn.monthlyBurnUsdMinor)}/mo spend`
              : `On ${formatMoney(burn.netMonthlyBurnUsdMinor)}/mo net burn`
          }
          href="/transactions?operating=1&direction=outflow"
          tone={runwayTone}
          emphasis
        />
        <StatTile
          label="Break-even revenue"
          value={formatMoney(breakEven.requiredRevenueUsdMinor)}
          hint={`Needed in ${formatMonthLabel(asOf)} to cover expected cost`}
          href={`/transactions?direction=outflow&from=${month.from}&to=${asOf}&operating=1`}
          emphasis
        />
        <StatTile
          label={breakEven.gapUsdMinor > 0 ? 'Revenue gap' : 'Above break-even'}
          value={formatMoney(breakEven.gapUsdMinor > 0 ? breakEven.gapUsdMinor : breakEven.surplusUsdMinor)}
          hint={
            breakEven.gapUsdMinor > 0
              ? `Still to collect with ${breakEven.daysRemaining} days left`
              : 'Revenue has covered expected cost'
          }
          href={`/transactions?direction=inflow&from=${month.from}&to=${asOf}&operating=1`}
          tone={breakEven.gapUsdMinor > 0 ? 'warn' : 'inflow'}
          emphasis
        />
      </div>

      {/* ── This month ──────────────────────────────────────────────────── */}
      <div className="mb-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Revenue received (MTD)"
          value={formatMoney(monthToDate.inflowUsdMinor)}
          hint={
            snapshot.revenueMoMChange === null
              ? `vs. ${formatMoney(previousMonth.inflowUsdMinor)} last month`
              : `${formatPercent(snapshot.revenueMoMChange)} vs. last month`
          }
          href={`/transactions?direction=inflow&from=${month.from}&to=${asOf}&operating=1`}
          tone="inflow"
        />
        <StatTile
          label="Spent (MTD)"
          value={formatMoney(monthToDate.outflowUsdMinor)}
          hint={`vs. ${formatMoney(previousMonth.outflowUsdMinor)} last month`}
          href={`/transactions?direction=outflow&from=${month.from}&to=${asOf}&operating=1`}
          tone="outflow"
        />
        <StatTile
          label="Net profit (MTD)"
          value={formatMoney(snapshot.netProfitMtdUsdMinor)}
          hint="Cash basis: money received less money spent"
          href={`/transactions?from=${month.from}&to=${asOf}&operating=1`}
          tone={snapshot.netProfitMtdUsdMinor >= 0 ? 'inflow' : 'outflow'}
        />
        <StatTile
          label="Monthly burn"
          value={formatMoney(burn.monthlyBurnUsdMinor)}
          hint={`Average outflow over ${burn.monthsSampled} complete month${burn.monthsSampled > 1 ? 's' : ''}`}
          href={`/transactions?direction=outflow&from=${burn.window.from}&to=${burn.window.to}&operating=1`}
        />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        {/* ── Cash trend ────────────────────────────────────────────────── */}
        <Card>
          <SectionHeader
            title="Cash, last 30 days"
            subtitle="Reconstructed backwards from today balance through every non-duplicate transaction."
          />
          <CashTrend points={trend} />

          {/* ── Runway, all three ways (spec §9) ────────────────────────── */}
          <div className="mt-4 grid grid-cols-3 gap-4 border-t border-[var(--line)] pt-4">
            <RunwayFigure
              label="If revenue stopped"
              months={runway.grossMonths}
              detail={`${formatMoney(burn.monthlyBurnUsdMinor)}/mo spend`}
            />
            <RunwayFigure
              label="At current net burn"
              months={runway.netMonths}
              detail={
                runway.cashPositive
                  ? 'Revenue covers spend'
                  : `${formatMoney(burn.netMonthlyBurnUsdMinor)}/mo net`
              }
            />
            <RunwayFigure
              label="Worst month on record"
              months={runway.worstCaseMonths}
              detail={
                burn.worstMonth
                  ? `${formatMoney(burn.worstMonthOutflowUsdMinor)} in ${formatMonthLabel(burn.worstMonth)}`
                  : 'No history yet'
              }
              danger
            />
          </div>

          {cash.heldForReviewUsdMinor > 0 && (
            <FormulaNote>
              {formatMoney(cash.heldForReviewUsdMinor)} is held out of these totals pending
              duplicate review.{' '}
              <Link href="/reconcile" className="underline underline-offset-2">
                Review the queue
              </Link>
              .
            </FormulaNote>
          )}
        </Card>

        {/* ── Break-even maths, shown openly ────────────────────────────── */}
        <Card>
          <SectionHeader
            title={`Break-even for ${formatMonthLabel(asOf)}`}
            subtitle="Deterministic, not estimated."
          />
          <dl className="space-y-2.5 text-[13px]">
            <Row label="Spent so far this month" value={<Money minor={breakEven.expenseToDateUsdMinor} />} />
            <Row
              label={`Projected remaining (${breakEven.daysRemaining} days)`}
              value={<Money minor={breakEven.projectedRemainingExpenseUsdMinor} />}
            />
            <div className="border-t border-[var(--line)] pt-2.5">
              <Row
                label="Revenue required"
                value={<Money minor={breakEven.requiredRevenueUsdMinor} className="font-semibold" />}
                strong
              />
            </div>
            <Row label="Revenue received" value={<Money minor={breakEven.revenueReceivedUsdMinor} direction="inflow" />} />
            <div className="border-t border-[var(--line)] pt-2.5">
              <Row
                label={breakEven.gapUsdMinor > 0 ? 'Still needed' : 'Surplus'}
                value={
                  <Money
                    minor={breakEven.gapUsdMinor > 0 ? breakEven.gapUsdMinor : breakEven.surplusUsdMinor}
                    className="font-semibold"
                    direction={breakEven.gapUsdMinor > 0 ? 'outflow' : 'inflow'}
                  />
                }
                strong
              />
            </div>
          </dl>
          <FormulaNote>
            Required = spend booked this month + (trailing 90-day average daily outflow of{' '}
            {formatMoney(breakEven.avgDailyOutflowUsdMinor)} × {breakEven.daysRemaining} days
            remaining). As real spend lands, the projected share shrinks and the number converges
            on actuals.
          </FormulaNote>
        </Card>
      </div>

      {/* ── Cash by account ───────────────────────────────────────────────── */}
      <Card padded={false} className="mb-6">
        <div className="p-5 pb-0">
          <SectionHeader
            title="Where the cash is"
            subtitle="Click any account to see the transactions behind its balance."
            action={<LinkButton href="/accounts">All accounts</LinkButton>}
          />
        </div>
        {cash.byAccount.length === 0 ? (
          <EmptyState
            title="No accounts yet"
            body="Connect QuickBooks, Plaid or Stripe, or import a CSV, and balances will appear here."
            action={<LinkButton href="/integrations" variant="primary">Connect a source</LinkButton>}
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Source</th>
                <th className="text-right">Balance</th>
                <th className="text-right">In USD</th>
                <th className="text-right">Transactions</th>
              </tr>
            </thead>
            <tbody>
              {cash.byAccount.slice(0, 8).map((b) => (
                <tr key={b.account.id}>
                  <td>
                    <Link href={`/transactions?account=${b.account.id}`} className="font-medium hover:underline">
                      {b.account.name}
                    </Link>
                    {!b.account.include_in_cash && (
                      <span className="faint ml-2 text-[11px]">excluded from cash</span>
                    )}
                  </td>
                  <td className="muted capitalize">{b.account.source_system.replace(/_/g, ' ')}</td>
                  <td className="text-right">
                    <Money minor={b.balanceMinor} currency={b.account.currency} />
                  </td>
                  <td className="tabular text-right muted">{formatMoney(b.balanceUsdMinor)}</td>
                  <td className="tabular text-right muted">{b.txnCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* ── Latest movement ───────────────────────────────────────────────── */}
      <Card padded={false}>
        <div className="p-5 pb-0">
          <SectionHeader
            title="Latest movement"
            action={<LinkButton href="/transactions">All transactions</LinkButton>}
          />
        </div>
        {recent.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            body="Once a source is connected or a CSV is imported, every dollar in and out shows up here within minutes."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Counterparty</th>
                <th>Category</th>
                <th>Account</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((t) => (
                <tr key={t.id}>
                  <td className="tabular muted whitespace-nowrap">{t.txn_date}</td>
                  <td>
                    <Link href={`/transactions/${t.id}`} className="font-medium hover:underline">
                      {t.counterparty?.name ?? t.description ?? 'Unknown'}
                    </Link>
                  </td>
                  <td className="muted">{categoryLabel(t.category)}</td>
                  <td className="muted">{t.account?.name ?? '—'}</td>
                  <td className="text-right">
                    <Money minor={t.amount_minor} currency={t.currency} direction={t.direction} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <p className="faint mt-6 text-[11.5px] leading-relaxed">
        Burn window: {burn.window.from} → {burn.window.to} ({burn.monthsSampled} complete{' '}
        {burn.monthsSampled === 1 ? 'month' : 'months'}; the current partial month is excluded so
        runway is not flattered). Balances shown are the provider-reported figure where one exists,
        otherwise opening balance plus transactions.
        {monthStart(asOf) === asOf && ' Today is the first of the month, so month-to-date figures are still near zero.'}
      </p>
    </>
  );
}

/**
 * One runway figure. Spec §9 asks for current AND downside runway, because a
 * single number cannot carry both "we are fine" and "we are one bad month from
 * trouble" - and the second is the one that changes decisions.
 */
function RunwayFigure({
  label,
  months,
  detail,
  danger = false,
}: {
  label: string;
  months: number | null;
  detail: string;
  danger?: boolean;
}) {
  const critical = months !== null && months < 6;
  return (
    <div>
      <p className="faint text-[10.5px] font-semibold uppercase tracking-[0.05em]">{label}</p>
      <p
        className="tabular mt-1 text-[17px] font-semibold"
        style={{ color: critical && danger ? 'var(--outflow)' : critical ? 'var(--warn)' : undefined }}
      >
        {months === null ? '—' : formatMonths(months)}
      </p>
      <p className="faint mt-0.5 text-[11px] leading-tight">{detail}</p>
    </div>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? 'font-medium' : 'muted'}>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}
