import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession, sessionCan } from '@/lib/auth';
import { loadProjectPortfolio } from '@/lib/data';
import { rollUpBy, type RollupDimension, type RollupGroup } from '@/lib/calc/projects';
import type { AllocationResult } from '@/lib/calc/allocation';
import { formatMoney, formatPercent } from '@/lib/money';
import { formatDayLabel } from '@/lib/dates';
import { NewProjectButton } from '@/components/NewProjectButton';
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
 * Project and event profitability - Spec sections 12, 14, 15, 16.
 *
 * Every figure here comes from transactions actually assigned to a project.
 * Nothing is spread, apportioned or estimated: spec 16 draws a line between
 * direct costs and allocated ones, and only the direct side can be answered
 * from a bank feed. The unassigned total is shown rather than hidden, so the
 * sum of these P&Ls and the company P&L can be reconciled on sight instead of
 * quietly disagreeing.
 */
/** Spec §16's five groupings, in the order a CEO asks for them. */
const DIMENSIONS: Array<{ key: RollupDimension; label: string }> = [
  { key: 'business_unit', label: 'Business unit' },
  { key: 'client', label: 'Client' },
  { key: 'service', label: 'Service' },
  { key: 'kind', label: 'Projects vs events' },
  { key: 'status', label: 'Status' },
];

function pickDimension(raw: string | undefined): RollupDimension {
  return DIMENSIONS.find((d) => d.key === raw)?.key ?? 'business_unit';
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: { by?: string };
}) {
  const dimension = pickDimension(searchParams.by);
  const supabase = createSupabaseServerClient();
  const session = await requireSession();
  const canEdit = sessionCan(session, 'move_money');
  // Labour is compensation. Asked for explicitly rather than inferred from an
  // empty result — see decision 90.
  const { rows, totals, unassigned, units, labourByProject, softwareByProject, softwareAllocation } =
    await loadProjectPortfolio(supabase, undefined, {
      canSeeCompensation: sessionCan(session, 'see_compensation'),
    });

  const active = rows.filter((r) => r.project.status === 'active' || r.project.status === 'planned');
  const withActivity = [...rows].sort(
    (a, b) => b.pnl.cashReceivedUsdMinor - a.pnl.cashReceivedUsdMinor,
  );
  const groups = rollUpBy(
    rows,
    dimension,
    labourByProject ? (id) => labourByProject.get(id) ?? 0 : undefined,
    softwareByProject ? (id) => softwareByProject.get(id) ?? 0 : undefined,
  );
  const showLabour = labourByProject !== null;
  const totalLabour = showLabour
    ? groups.reduce((sum, g) => sum + (g.labourUsdMinor ?? 0), 0)
    : null;
  const unassignedOutflow = unassigned
    .filter((t) => t.direction === 'outflow' && !t.is_internal_transfer)
    .reduce((s, t) => s + (t.amount_usd_minor ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Projects & events"
        subtitle="What each piece of work brought in, what it cost, and what is left."
        action={canEdit ? <NewProjectButton units={units} /> : undefined}
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No projects yet"
            body={
              canEdit
                ? 'Create one, then assign transactions to it from the transaction page. A project P&L is built from the lines attributed to it — nothing is apportioned automatically.'
                : 'Nobody has created a project yet. Once one exists, the money attributed to it appears here.'
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Cash received"
              value={formatMoney(totals.cashReceivedUsdMinor)}
              hint={`Across ${totals.projectCount} project${totals.projectCount === 1 ? '' : 's'}`}
              tone="inflow"
            />
            <StatTile
              label="Direct cost"
              value={formatMoney(totals.directExpenseUsdMinor)}
              hint="Only what was attributed to a project"
              tone="outflow"
            />
            <StatTile
              label="Gross profit"
              value={formatMoney(totals.grossProfitUsdMinor)}
              hint={
                totals.grossMarginRatio === null
                  ? 'No margin until something is received'
                  : `${formatPercent(totals.grossMarginRatio, 0)} margin`
              }
              tone={totals.grossProfitUsdMinor < 0 ? 'outflow' : 'inflow'}
              emphasis
            />
            <StatTile
              label="Losing money"
              value={String(totals.lossMakingCount)}
              hint={
                totals.lossMakingCount
                  ? 'Costs exceed what has come in'
                  : 'Every started project is ahead'
              }
              tone={totals.lossMakingCount ? 'warn' : 'neutral'}
            />
          </div>

          <FormulaNote>
            Gross profit is cash received less the direct costs attributed to the project. It is
            not net profit: nothing here carries a share of salaries, software or overhead,
            because attributing those needs time data the system does not have yet. Every
            margin on this page is therefore the ceiling, not the answer.
          </FormulaNote>

          {unassigned.length > 0 && (
            <div className="mt-6">
              <Callout tone="neutral" title="Money that belongs to no project">
                {formatMoney(unassignedOutflow)} of spending and{' '}
                {totals.unassignedCount.toLocaleString()} transactions in the last two years are
                not attributed to anything. Much of that is real overhead and should stay
                unassigned. The rest is why these P&Ls read better than the company does —{' '}
                <Link href="/transactions?unassigned=1" className="underline underline-offset-2">
                  review the unassigned lines
                </Link>
                .
              </Callout>
            </div>
          )}

          <section className="mt-7">
            <SectionHeader
              title="Every project"
              subtitle={`${active.length} active or planned, ${rows.length - active.length} closed`}
            />
            <Card padded={false} className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--line)] text-left">
                    <Th>Project</Th>
                    <Th>Business unit</Th>
                    <Th>Client</Th>
                    <Th className="text-right">Received</Th>
                    <Th className="text-right">Direct cost</Th>
                    <Th className="text-right">Gross profit</Th>
                    <Th className="text-right">Margin</Th>
                    <Th className="text-right">Lines</Th>
                  </tr>
                </thead>
                <tbody>
                  {withActivity.map(({ project, pnl }) => (
                    <tr key={project.id} className="border-b border-[var(--line)] last:border-0">
                      <Td>
                        <Link
                          href={`/projects/${project.id}`}
                          className="font-medium hover:underline"
                        >
                          {project.name}
                        </Link>
                        <span className="ml-2">
                          {project.kind === 'event' && <Badge tone="brand">event</Badge>}
                          {project.status === 'completed' && <Badge>closed</Badge>}
                          {project.status === 'cancelled' && <Badge tone="warn">cancelled</Badge>}
                        </span>
                        {pnl.lastActivity && (
                          <p className="faint mt-0.5 text-[11px]">
                            Last activity {formatDayLabel(pnl.lastActivity)}
                          </p>
                        )}
                      </Td>
                      <Td className="muted">{project.business_unit?.name ?? '—'}</Td>
                      <Td className="muted">{project.client?.name ?? '—'}</Td>
                      <Td className="tabular text-right">
                        {formatMoney(pnl.cashReceivedUsdMinor)}
                      </Td>
                      <Td className="tabular text-right">
                        {formatMoney(pnl.directExpenseUsdMinor)}
                      </Td>
                      <Td
                        className="tabular text-right font-medium"
                        style={{
                          color:
                            pnl.transactionCount === 0
                              ? undefined
                              : pnl.grossProfitUsdMinor < 0
                                ? 'var(--outflow)'
                                : 'var(--inflow)',
                        }}
                      >
                        {pnl.transactionCount === 0 ? '—' : formatMoney(pnl.grossProfitUsdMinor)}
                      </Td>
                      <Td className="muted tabular text-right">
                        {pnl.grossMarginRatio === null
                          ? '—'
                          : formatPercent(pnl.grossMarginRatio, 0)}
                      </Td>
                      <Td className="muted tabular text-right">{pnl.transactionCount}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>

          {/* Spec §16: profitability by whichever cut is being asked about. */}
          <section className="mt-7">
            <SectionHeader
              title="Profitability by"
              subtitle="The same project P&Ls above, grouped. Nothing is recomputed — a roll-up derived independently is a second implementation of the same arithmetic, and the first time the two disagree nobody can tell which is wrong."
            />

            <div className="mb-4 flex flex-wrap gap-2">
              {DIMENSIONS.map((d) => (
                <Link
                  key={d.key}
                  href={`/projects?by=${d.key}`}
                  className="rounded-full px-3 py-1.5 text-[12.5px] font-medium"
                  style={{
                    background: d.key === dimension ? 'var(--brand-soft)' : 'var(--surface-sunk)',
                    color: d.key === dimension ? 'var(--brand)' : 'var(--text-muted)',
                  }}
                >
                  {d.label}
                </Link>
              ))}
            </div>

            <Rollup
              groups={groups}
              totals={totals}
              showLabour={showLabour}
              allocation={softwareAllocation}
            />
          </section>

          <div className="mt-7">
            <Callout tone="neutral" title="What is missing from every margin here">
              {showLabour ? (
                <>
                  Logged time is now counted — the <strong>After labour</strong> column above is
                  gross profit less what the hours cost
                  {totalLabour !== null && totalLabour === 0
                    ? ', and it currently equals gross profit because nobody has logged any hours yet'
                    : ''}
. Shared software is spread across projects{' '}
                  <strong>by share of logged hours</strong> — the only cost driver this system
                  has data for, and the one that charges the projects people actually worked on.
                  {softwareAllocation?.reason ? (
                    <>
                      {' '}
                      It is <strong>not</strong> spread right now:{' '}
                      {formatMoney(softwareAllocation.unallocatedUsdMinor)} of software sits unallocated
                      because nobody has logged hours. An even split would charge a project
                      nobody touched.
                    </>
                  ) : null}{' '}
                  Software already attributed to a project directly is left alone — spreading it
                  again would charge that project twice. The <strong>Gross profit</strong> column
                  deliberately excludes both, so it keeps meaning what it meant last month.
                </>
              ) : (
                <>
                  Employee time and the software a project consumes are both real costs, and your
                  role does not include seeing what people cost — so the labour columns are absent
                  rather than shown as zero. Treat these as gross figures with a known gap, not as
                  net profit.
                </>
              )}
            </Callout>
          </div>
        </>
      )}
    </>
  );
}

/**
 * One grouping of the portfolio, and proof that it still adds up.
 *
 * `tests/projects.test.ts` asserts that every dimension sums back to the
 * portfolio total. That assertion is worth more on the screen than in a test
 * file: a reader who can see the group totals equal the headline figure does
 * not have to take somebody's word for it. Rows with nothing in the dimension
 * land in an explicit "Not set" group rather than being dropped, which is what
 * makes the sum hold in the first place.
 */
function Rollup({
  groups,
  totals,
  showLabour,
}: {
  groups: RollupGroup[];
  totals: { cashReceivedUsdMinor: number; grossProfitUsdMinor: number };
  /**
   * False for a reader who may not see compensation. The columns are removed
   * rather than dashed out: a column of em-dashes invites the reader to assume
   * the number is zero, which is exactly what it is not.
   */
  showLabour: boolean;
  /** The software pool and, when nothing could be spread, the reason. */
  allocation: AllocationResult | null;
}) {
  if (groups.length === 0) {
    return (
      <EmptyState title="Nothing to group yet" body="Create a project and attribute money to it." />
    );
  }

  const summed = groups.reduce((s, g) => s + g.cashReceivedUsdMinor, 0);
  const profitSummed = groups.reduce((s, g) => s + g.grossProfitUsdMinor, 0);
  const reconciles =
    summed === totals.cashReceivedUsdMinor && profitSummed === totals.grossProfitUsdMinor;

  const widest = Math.max(...groups.map((g) => Math.abs(g.cashReceivedUsdMinor)), 1);

  return (
    <>
      {!reconciles && (
        <div className="mb-4">
          <Callout tone="outflow" title="This grouping does not add up">
            The groups total {formatMoney(summed)} against a portfolio of{' '}
            {formatMoney(totals.cashReceivedUsdMinor)}. A project has fallen out of every group,
            so one of these two figures is wrong.
          </Callout>
        </div>
      )}

      <Card padded={false} className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[var(--line)] text-left">
              <Th>Group</Th>
              <Th className="text-right">Received</Th>
              <Th className="text-right">Direct cost</Th>
              <Th className="text-right">Gross profit</Th>
              {showLabour && <Th className="text-right">Labour</Th>}
              {showLabour && <Th className="text-right">Software</Th>}
              {showLabour && <Th className="text-right">After both</Th>}
              <Th className="text-right">Margin</Th>
              <Th className="text-right">Projects</Th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key} className="border-b border-[var(--line)] last:border-0">
                <Td>
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="hidden h-1.5 rounded-full sm:block"
                      style={{
                        width: `${Math.max(3, (Math.abs(g.cashReceivedUsdMinor) / widest) * 64)}px`,
                        background: 'var(--brand)',
                        opacity: 0.35,
                      }}
                    />
                    <span className={g.key === '__unassigned__' ? 'muted' : 'font-medium'}>
                      {g.label}
                    </span>
                  </div>
                </Td>
                <Td className="tabular text-right">{formatMoney(g.cashReceivedUsdMinor)}</Td>
                <Td className="tabular text-right">{formatMoney(g.directExpenseUsdMinor)}</Td>
                <Td
                  className="tabular text-right font-medium"
                  style={{ color: g.grossProfitUsdMinor < 0 ? 'var(--outflow)' : undefined }}
                >
                  {formatMoney(g.grossProfitUsdMinor)}
                </Td>
                {showLabour && (
                  <Td className="tabular muted text-right">
                    {formatMoney(g.labourUsdMinor ?? 0)}
                  </Td>
                )}
                {showLabour && (
                  <Td className="tabular muted text-right">
                    {/* A dash, not $0.00, when there was no basis to spread by.
                        Zero would read as "this group uses no software". */}
                    {g.softwareUsdMinor === null ? '—' : formatMoney(g.softwareUsdMinor)}
                  </Td>
                )}
                {showLabour && (
                  <Td
                    className="tabular text-right font-medium"
                    style={{
                      color:
                        (g.profitAfterLabourUsdMinor ?? 0) < 0 ? 'var(--outflow)' : undefined,
                    }}
                  >
                    {formatMoney(g.profitAfterLabourUsdMinor ?? 0)}
                  </Td>
                )}
                <Td className="tabular muted text-right">
                  {/* A dash, not 0%. A group that has received nothing has no
                      margin at all, and 0% reads as breaking even. */}
                  {g.grossMarginRatio === null ? '—' : formatPercent(g.grossMarginRatio, 0)}
                </Td>
                <Td className="tabular muted text-right">
                  {g.projectCount}
                  {g.lossMakingCount > 0 && (
                    <span style={{ color: 'var(--outflow)' }}> · {g.lossMakingCount} losing</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-[var(--line)]">
              <Td className="faint text-[12px]">All groups</Td>
              <Td className="tabular text-right font-medium">{formatMoney(summed)}</Td>
              <Td />
              <Td className="tabular text-right font-medium">{formatMoney(profitSummed)}</Td>
              {showLabour && (
                <Td className="tabular text-right font-medium">
                  {formatMoney(groups.reduce((sum, g) => sum + (g.labourUsdMinor ?? 0), 0))}
                </Td>
              )}
              {showLabour && (
                <Td className="tabular text-right font-medium">
                  {formatMoney(groups.reduce((sum, g) => sum + (g.softwareUsdMinor ?? 0), 0))}
                </Td>
              )}
              {showLabour && (
                <Td className="tabular text-right font-medium">
                  {formatMoney(
                    groups.reduce((sum, g) => sum + (g.profitAfterLabourUsdMinor ?? 0), 0),
                  )}
                </Td>
              )}
              <Td colSpan={2} className="faint text-right text-[11px]">
                {reconciles ? 'matches the portfolio total above' : 'does NOT match'}
              </Td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </>
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

function Td({
  children,
  className = '',
  style,
  colSpan,
}: {
  /** Optional: a spacer cell in a footer row has nothing to say. */
  children?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  colSpan?: number;
}) {
  return (
    <td className={`px-4 py-2.5 ${className}`} style={style} colSpan={colSpan}>
      {children}
    </td>
  );
}
