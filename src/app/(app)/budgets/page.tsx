import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession, sessionCan } from '@/lib/auth';
import { loadBudgetBoard, loadBudgetTargets } from '@/lib/data';
import { formatMoney, formatPercent } from '@/lib/money';
import { formatDayLabel } from '@/lib/dates';
import { categoryLabel } from '@/lib/categorize';
import { BudgetEditor } from '@/components/BudgetEditor';
import type { BudgetStatus } from '@/lib/calc/budgets';
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  FormulaNote,
  PageHeader,
  SectionHeader,
  StatTile,
} from '@/components/ui';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/**
 * Budget vs. actual - Spec section 19.
 *
 * Five of the six figures section 19 asks for are arithmetic. The sixth - the
 * projected final cost - is a guess about the future, and it is the one this
 * kind of page usually gets wrong: two days into a month, one large payment
 * makes a run rate read many times the budget.
 *
 * So the projection is never shown on its own. Every row carries how much the
 * projection can be trusted, and the "at risk" tile counts only the ones where
 * that is at least even money. A column full of false alarms is a column
 * nobody reads, and then the real alarm is missed too.
 */
export default async function BudgetsPage() {
  const supabase = createSupabaseServerClient();
  const [session, board, targets] = await Promise.all([
    requireSession(),
    loadBudgetBoard(supabase),
    loadBudgetTargets(supabase),
  ]);
  const canEdit = sessionCan(session, 'move_money');

  const { statuses, totals, projectsWithTwoBudgets } = board;
  const open = statuses.filter((s) => !s.progress.hasEnded);
  const closed = statuses.filter((s) => s.progress.hasEnded);

  return (
    <>
      <PageHeader
        title="Budget vs. actual"
        subtitle="What was planned, what has been spent, and where the pace is heading."
        action={canEdit ? <BudgetEditor targets={targets} /> : undefined}
      />

      {statuses.length === 0 ? (
        <Card>
          <EmptyState
            title="No budgets set"
            body={
              canEdit
                ? 'A budget can cover everything the company spends, one category, a business unit, a client, a project or a legal entity. Spending is matched to it from the ledger — nothing has to be entered twice.'
                : 'Nobody has set a budget yet. Once one exists, spending is measured against it here.'
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Budgeted"
              value={formatMoney(totals.budgetUsdMinor)}
              hint={`${totals.count} budget${totals.count === 1 ? '' : 's'}`}
            />
            <StatTile
              label="Spent against them"
              value={formatMoney(totals.actualUsdMinor)}
              tone="outflow"
            />
            <StatTile
              label="Remaining"
              value={formatMoney(totals.remainingUsdMinor)}
              hint={totals.remainingUsdMinor < 0 ? 'Over, in aggregate' : 'Across every budget'}
              tone={totals.remainingUsdMinor < 0 ? 'outflow' : 'inflow'}
              emphasis
            />
            <StatTile
              label="Over or heading there"
              value={`${totals.overspentCount} + ${totals.atRiskCount}`}
              hint={`${totals.overspentCount} already over, ${totals.atRiskCount} projected to go over`}
              tone={totals.overspentCount + totals.atRiskCount > 0 ? 'warn' : 'neutral'}
            />
          </div>

          <FormulaNote>
            The projection is a straight run rate: what the period ends at if the rest of it looks
            like the part so far. That assumption is weakest exactly when a projection is most
            tempting to read — early in a period, or when spending arrives in a few large payments
            — so every row states how much of it to believe, and the tile above counts only the
            ones where that is at least even money.
          </FormulaNote>

          {projectsWithTwoBudgets.length > 0 && (
            <div className="mt-6">
              <Callout tone="warn" title="Two budgets for the same project">
                {projectsWithTwoBudgets.map((p) => p.name).join(', ')} carr
                {projectsWithTwoBudgets.length === 1 ? 'ies' : 'y'} a lifetime budget on the project
                itself and a period budget here. Both are legitimate — one is what the work may cost
                in total, the other what it may cost this period — but they are different numbers
                measuring different things, and a reader seeing both without knowing that will
                assume one is wrong.
              </Callout>
            </div>
          )}

          {open.length > 0 && (
            <section className="mt-7">
              <SectionHeader
                title="Open periods"
                subtitle="Still running, so the projection still means something"
              />
              <BudgetTable statuses={open} />
            </section>
          )}

          {closed.length > 0 && (
            <section className="mt-7">
              <SectionHeader
                title="Closed periods"
                subtitle="Finished — the actual is the final, and nothing is projected"
              />
              <BudgetTable statuses={closed} />
            </section>
          )}
        </>
      )}
    </>
  );
}

function BudgetTable({ statuses }: { statuses: BudgetStatus[] }) {
  return (
    <Card padded={false} className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-[var(--line)] text-left">
            <Th>Budget</Th>
            <Th>Period</Th>
            <Th className="text-right">Budget</Th>
            <Th className="text-right">Actual</Th>
            <Th className="text-right">Remaining</Th>
            <Th className="text-right">Variance</Th>
            <Th className="text-right">Projected final</Th>
          </tr>
        </thead>
        <tbody>
          {statuses.map((s) => (
            <tr key={s.budget.id} className="border-b border-[var(--line)] last:border-0">
              <Td>
                <span className="font-medium">{s.budget.name}</span>
                <span className="ml-2">
                  {s.overspent && <Badge tone="outflow">over</Badge>}
                  {!s.overspent && s.projectedToOverspend && s.projectionConfidence >= 0.5 && (
                    <Badge tone="warn">heading over</Badge>
                  )}
                </span>
                <p className="faint mt-0.5 text-[11px]">{scopeLabel(s)}</p>
              </Td>
              <Td className="muted">
                {formatDayLabel(s.periodStart)} – {formatDayLabel(s.periodEnd)}
                <p className="faint mt-0.5 text-[11px]">
                  {s.progress.hasEnded
                    ? 'closed'
                    : `day ${s.progress.daysElapsed} of ${s.progress.daysTotal}`}
                </p>
              </Td>
              <Td className="tabular text-right">{formatMoney(s.budgetUsdMinor)}</Td>
              <Td className="tabular text-right">
                <Link
                  href={budgetDrilldown(s)}
                  className="hover:underline"
                  title={`${s.transactionCount} payments`}
                >
                  {formatMoney(s.actualUsdMinor)}
                </Link>
              </Td>
              <Td
                className="tabular text-right font-medium"
                style={{ color: s.remainingUsdMinor < 0 ? 'var(--outflow)' : undefined }}
              >
                {formatMoney(s.remainingUsdMinor)}
              </Td>
              <Td className="muted tabular text-right">
                {/* A zero budget makes every variance infinite. */}
                {s.varianceRatio === null ? '—' : formatPercent(s.varianceRatio, 0)}
              </Td>
              <Td className="tabular text-right">
                {s.progress.hasEnded ? (
                  <span className="muted">{formatMoney(s.actualUsdMinor)}</span>
                ) : s.projectionConfidence < 0.25 ? (
                  // Below this the run rate is arithmetic on almost no evidence.
                  // Printing it would train the reader to ignore the column.
                  <span className="faint" title="Too early, or too few payments, to project from">
                    too early to say
                  </span>
                ) : (
                  <>
                    <span
                      style={{
                        color:
                          s.projectedFinalUsdMinor > s.budgetUsdMinor ? 'var(--warn)' : undefined,
                      }}
                    >
                      {formatMoney(s.projectedFinalUsdMinor)}
                    </span>
                    <p className="faint mt-0.5 text-[11px]">
                      {Math.round(s.projectionConfidence * 100)}% confidence
                    </p>
                  </>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function scopeLabel(s: BudgetStatus): string {
  switch (s.budget.scope) {
    case 'total':
      return 'Everything the company spends';
    case 'category':
      return `Category: ${categoryLabel(s.budget.scope_key)}`;
    case 'business_unit':
      return 'Business unit';
    case 'client':
      return 'Client';
    case 'project':
      return 'Project or event';
    case 'company':
      return 'Legal entity';
  }
}

/** Every figure drills to the payments behind it (spec §16). */
function budgetDrilldown(s: BudgetStatus): string {
  const params = new URLSearchParams({
    from: s.periodStart,
    to: s.periodEnd,
    direction: 'outflow',
    operating: '1',
  });
  if (s.budget.scope === 'category' && s.budget.scope_key) {
    params.set('category', s.budget.scope_key);
  }
  if (s.budget.scope === 'project' && s.budget.scope_id) {
    params.set('project', s.budget.scope_id);
  }
  return `/transactions?${params.toString()}`;
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

function Td({
  children,
  className = '',
  style,
  title,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  return (
    <td className={`px-4 py-2.5 ${className}`} style={style} title={title}>
      {children}
    </td>
  );
}
