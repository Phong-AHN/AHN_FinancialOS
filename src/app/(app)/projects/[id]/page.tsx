import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession, sessionCan } from '@/lib/auth';
import { loadProject } from '@/lib/data';
import { formatMoney, formatPercent } from '@/lib/money';
import { formatDayLabel } from '@/lib/dates';
import { categoryLabel } from '@/lib/categorize';
import type { CategoryLine } from '@/lib/calc/projects';
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  FormulaNote,
  Money,
  PageHeader,
  SectionHeader,
  StatTile,
} from '@/components/ui';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/**
 * One project's P&L - Spec sections 12 and 14.
 *
 * An event uses the same page as a project, because spec §14 says to treat an
 * event as a project and the arithmetic is identical. Only the category names
 * differ, and those come from the transactions themselves rather than from a
 * fixed list — a sponsorship shows up as whatever the ledger called it, not as
 * whatever a hardcoded taxonomy expected.
 */
export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const session = await requireSession();
  // Labour cost is compensation. The page asks for it explicitly rather than
  // letting the loader infer it from an empty result — see `loadProject`.
  const loaded = await loadProject(supabase, params.id, {
    canSeeCompensation: sessionCan(session, 'see_compensation'),
  });
  if (!loaded) notFound();

  const { project, pnl, transactions, labour, net, doubleCount } = loaded;
  const isEvent = project.kind === 'event';

  return (
    <>
      <PageHeader
        title={project.name}
        subtitle={[
          project.business_unit?.name,
          project.service,
          project.client?.name ? `for ${project.client.name}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Badge tone={isEvent ? 'brand' : 'neutral'}>{isEvent ? 'Event' : 'Project'}</Badge>
        <Badge tone={project.status === 'cancelled' ? 'warn' : 'neutral'}>{project.status}</Badge>
        {pnl.firstActivity && (
          <span className="faint text-[12px]">
            Activity from {formatDayLabel(pnl.firstActivity)} to{' '}
            {formatDayLabel(pnl.lastActivity!)}
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Cash received"
          value={formatMoney(pnl.cashReceivedUsdMinor)}
          hint={`${pnl.transactionCount} attributed line${pnl.transactionCount === 1 ? '' : 's'}`}
          tone="inflow"
        />
        <StatTile
          label="Direct cost"
          value={formatMoney(pnl.directExpenseUsdMinor)}
          hint={
            pnl.budgetVarianceUsdMinor === null
              ? 'No budget recorded'
              : pnl.budgetVarianceUsdMinor > 0
                ? `${formatMoney(pnl.budgetVarianceUsdMinor)} over budget`
                : `${formatMoney(-pnl.budgetVarianceUsdMinor)} under budget`
          }
          tone="outflow"
        />
        <StatTile
          label="Gross profit"
          value={pnl.transactionCount === 0 ? '—' : formatMoney(pnl.grossProfitUsdMinor)}
          hint={
            pnl.grossMarginRatio === null
              ? 'No margin until money is received'
              : `${formatPercent(pnl.grossMarginRatio, 0)} margin`
          }
          tone={pnl.grossProfitUsdMinor < 0 ? 'outflow' : 'inflow'}
          emphasis
        />
        {net && labour ? (
          <StatTile
            label="Net profit"
            value={pnl.transactionCount === 0 ? '—' : formatMoney(net.netProfitUsdMinor)}
            hint={
              labour.actualCostUsdMinor === 0
                ? 'No time logged — same as gross'
                : `After ${formatMoney(labour.actualCostUsdMinor)} of people`
            }
            tone={net.netProfitUsdMinor < 0 ? 'outflow' : 'inflow'}
          />
        ) : (
          <StatTile
            label={isEvent ? 'ROI' : 'Return on spend'}
            value={pnl.roiRatio === null ? '—' : formatPercent(pnl.roiRatio, 0)}
            hint="Gross profit over what was spent"
            tone={pnl.roiRatio !== null && pnl.roiRatio < 0 ? 'outflow' : 'neutral'}
          />
        )}
      </div>

      {doubleCount && (
        <div className="mt-5">
          <Callout tone="warn" title="This project is being charged for its people twice">
            {formatMoney(doubleCount.attributedPayrollUsdMinor)} of payroll is attributed to this{' '}
            {isEvent ? 'event' : 'project'} as a direct cost, and{' '}
            {formatMoney(doubleCount.allocatedLabourUsdMinor)} of the same people is allocated
            again from logged hours. Net profit above is understated by roughly the smaller of
            the two. Payroll normally stays unattributed and reaches projects only through time
            entries — detach{' '}
            {doubleCount.transactionCount === 1
              ? 'that line'
              : `those ${doubleCount.transactionCount} lines`}{' '}
            to fix it.
          </Callout>
        </div>
      )}

      {labour && (labour.actualHours > 0 || labour.estimatedHours !== null) && (
        <section className="mt-7">
          <SectionHeader
            title="People on this work"
            subtitle="Spec §13: hours logged, costed at each person's loaded rate"
          />
          <Card padded={false}>
            <div className="grid gap-4 border-b border-[var(--line)] p-5 sm:grid-cols-4">
              <Figure2 label="Hours logged" value={`${labour.actualHours}`} />
              <Figure2
                label="Estimated"
                value={labour.estimatedHours === null ? null : `${labour.estimatedHours}`}
                delta={
                  labour.hoursVariance === null
                    ? null
                    : `${labour.hoursVariance > 0 ? '+' : ''}${labour.hoursVariance}h vs estimate`
                }
                warn={(labour.hoursVariance ?? 0) > 0}
              />
              <Figure2 label="Labour cost" value={formatMoney(labour.actualCostUsdMinor)} />
              <Figure2
                label="Labour budget"
                value={
                  labour.labourBudgetUsdMinor === null
                    ? null
                    : formatMoney(labour.labourBudgetUsdMinor)
                }
                delta={
                  labour.costVarianceUsdMinor === null
                    ? null
                    : `${labour.costVarianceUsdMinor > 0 ? 'over by ' : 'under by '}${formatMoney(Math.abs(labour.costVarianceUsdMinor))}`
                }
                warn={(labour.costVarianceUsdMinor ?? 0) > 0}
              />
            </div>

            {labour.unpricedHours > 0 && (
              <div className="border-b border-[var(--line)] p-4">
                <p className="text-[12.5px]" style={{ color: 'var(--warn)' }}>
                  {labour.unpricedHours} hours were logged by people with no rate recorded. Those
                  hours cost something; this figure does not include it.
                </p>
              </div>
            )}

            <ul className="divide-y divide-[var(--line)]">
              {labour.byPerson.map((line) => (
                <li key={line.person.id} className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">{line.person.name}</p>
                    <p className="muted mt-0.5 text-[12px]">
                      {line.hours} hours · {line.person.kind}
                      {line.rateUnknown ? ' · no rate recorded' : ''}
                    </p>
                  </div>
                  <p className="tabular shrink-0 text-[13px]">
                    {line.rateUnknown ? (
                      <span className="faint">not costed</span>
                    ) : (
                      formatMoney(line.costUsdMinor)
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {(pnl.contractedRevenueUsdMinor !== null || pnl.invoicedRevenueUsdMinor !== null) && (
        <section className="mt-7">
          <SectionHeader
            title="Contracted, invoiced, collected"
            subtitle="The first two are entered by hand; only the third comes from the bank"
          />
          <Card>
            <div className="grid gap-4 sm:grid-cols-3">
              <Figure label="Contracted" value={pnl.contractedRevenueUsdMinor} />
              <Figure label="Invoiced" value={pnl.invoicedRevenueUsdMinor} />
              <Figure label="Received" value={pnl.cashReceivedUsdMinor} />
            </div>
            <div className="mt-4 grid gap-4 border-t border-[var(--line)] pt-4 sm:grid-cols-2">
              <Figure
                label="Sold but not yet invoiced"
                value={pnl.unbilledUsdMinor}
                tone="warn"
              />
              <Figure
                label="Invoiced but not yet received"
                value={pnl.outstandingUsdMinor}
                tone="warn"
              />
            </div>
          </Card>
        </section>
      )}

      {pnl.transactionCount === 0 ? (
        <div className="mt-7">
          <Card>
            <EmptyState
              title="Nothing has been attributed to this yet"
              body="Open a transaction and assign it to this project. Nothing is attributed automatically — a bank line does not say which project it belongs to, and guessing would be worse than leaving it blank."
              action={
                <Link href="/transactions?unassigned=1" className="text-[13px] underline underline-offset-2">
                  See unassigned transactions
                </Link>
              }
            />
          </Card>
        </div>
      ) : (
        <>
          <div className="mt-7 grid gap-5 lg:grid-cols-2">
            <Breakdown
              title={isEvent ? 'Revenue by source' : 'Revenue by category'}
              lines={pnl.revenueByCategory}
              total={pnl.cashReceivedUsdMinor}
              tone="inflow"
              projectId={project.id}
            />
            <Breakdown
              title="Cost by category"
              lines={pnl.expenseByCategory}
              total={pnl.directExpenseUsdMinor}
              tone="outflow"
              projectId={project.id}
            />
          </div>

          <section className="mt-7">
            <SectionHeader
              title="Every attributed line"
              subtitle="Spec §16: each figure above drills to the transactions behind it"
            />
            <Card padded={false} className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--line)] text-left">
                    <Th>Date</Th>
                    <Th>Description</Th>
                    <Th>Category</Th>
                    <Th className="text-right">Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t) => (
                    <tr key={t.id} className="border-b border-[var(--line)] last:border-0">
                      <Td className="muted tabular">{formatDayLabel(t.txn_date)}</Td>
                      <Td>
                        <Link
                          href={`/transactions/${t.id}`}
                          className="hover:underline"
                        >
                          {t.counterparty?.name ?? t.description ?? 'Transaction'}
                        </Link>
                        {t.is_internal_transfer && (
                          <span className="ml-2">
                            <Badge>transfer, excluded</Badge>
                          </span>
                        )}
                      </Td>
                      <Td className="muted">{categoryLabel(t.category)}</Td>
                      <Td className="tabular text-right">
                        <Money
                          minor={t.amount_usd_minor ?? t.amount_minor}
                          direction={t.direction}
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>
        </>
      )}

      <FormulaNote>
        Gross profit is cash received less the direct costs attributed to this{' '}
        {isEvent ? 'event' : 'project'}. Internal transfers and flagged duplicates are excluded
        from both sides — funding this from another company account is not revenue, and a
        double-booked payment is not a second cost.
      </FormulaNote>

      <div className="mt-5">
        {labour === null ? (
          <Callout tone="neutral" title="Labour cost is not visible to you">
            What people cost is compensation, and spec §23 restricts that to the owner. The
            figures above are therefore gross — before the cost of the people who did the work.
            No net profit is shown, because a net figure computed from zero labour would be the
            gross one wearing the wrong label.
          </Callout>
        ) : labour.actualHours === 0 ? (
          <Callout tone="neutral" title="Nobody has logged time against this">
            Net profit equals gross until someone does. Every project consumes people, so treat
            the figures above as an upper bound — and the software this{' '}
            {isEvent ? 'event' : 'project'} consumed is still not allocated either.
          </Callout>
        ) : (
          <Callout tone="neutral" title="Still not counted">
            Software allocated to this {isEvent ? 'event' : 'project'} is a real cost and does not
            appear above — only people and directly attributed spending do.
          </Callout>
        )}
      </div>
    </>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone?: 'warn';
}) {
  return (
    <div>
      <p className="faint text-[11px] font-semibold uppercase tracking-[0.05em]">{label}</p>
      <p
        className="tabular mt-1 text-[18px] font-semibold"
        style={{ color: tone === 'warn' && value ? 'var(--warn)' : undefined }}
      >
        {/* Null is not zero. "Not recorded" and "nothing owing" are different
            answers, and printing $0 for the first is how a gap becomes invisible. */}
        {value === null ? <span className="faint text-[14px]">not recorded</span> : formatMoney(value)}
      </p>
    </div>
  );
}

function Breakdown({
  title,
  lines,
  total,
  tone,
  projectId,
}: {
  title: string;
  lines: CategoryLine[];
  total: number;
  tone: 'inflow' | 'outflow';
  projectId: string;
}) {
  return (
    <section>
      <SectionHeader title={title} />
      <Card padded={false}>
        {lines.length === 0 ? (
          <div className="p-5">
            <p className="muted text-[13px]">Nothing on this side yet.</p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {lines.map((line) => (
              <li key={line.category} className="p-4">
                <div className="flex items-baseline justify-between gap-4">
                  <Link
                    href={`/transactions?project=${projectId}&category=${encodeURIComponent(line.category)}`}
                    className="truncate text-[13px] font-medium hover:underline"
                  >
                    {categoryLabel(line.category)}
                  </Link>
                  <span className="tabular shrink-0 text-[13px]">
                    {formatMoney(line.amountUsdMinor)}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div
                    className="h-1.5 flex-1 overflow-hidden rounded-full"
                    style={{ background: 'var(--surface-sunk)' }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(2, Math.round(line.shareOfSide * 100))}%`,
                        background: tone === 'inflow' ? 'var(--inflow)' : 'var(--outflow)',
                      }}
                    />
                  </div>
                  <span className="faint tabular w-14 shrink-0 text-right text-[11px]">
                    {formatPercent(line.shareOfSide, 0)}
                  </span>
                </div>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-4 p-4">
              <span className="text-[13px] font-semibold">Total</span>
              <span className="tabular text-[13px] font-semibold">{formatMoney(total)}</span>
            </li>
          </ul>
        )}
      </Card>
    </section>
  );
}

function Figure2({
  label,
  value,
  delta,
  warn,
}: {
  label: string;
  value: string | null;
  delta?: string | null;
  warn?: boolean;
}) {
  return (
    <div>
      <p className="faint text-[11px] font-semibold uppercase tracking-[0.05em]">{label}</p>
      <p className="tabular mt-1 text-[16px] font-semibold">
        {/* "not set" and a number are different answers; a blank would read as zero. */}
        {value === null ? <span className="faint text-[13px]">not set</span> : value}
      </p>
      {delta && (
        <p
          className="mt-0.5 text-[11px]"
          style={{ color: warn ? 'var(--warn)' : 'var(--text-muted)' }}
        >
          {delta}
        </p>
      )}
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th
      className={`faint px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 ${className}`}>{children}</td>;
}
