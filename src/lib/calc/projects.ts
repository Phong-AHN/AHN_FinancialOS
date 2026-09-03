/**
 * Project and event profitability - Spec sections 12, 14, 16.
 *
 * Pure functions over transactions already assigned to a project. No I/O, no
 * dates read from the clock, so every figure here is reproducible: the same
 * ledger produces the same P&L today and in six months.
 *
 * WHAT THIS COMPUTES AND WHAT IT REFUSES TO.
 *
 * Spec 12 lists eleven figures. The ledger supports four of them directly -
 * cash received, direct expenses, and the profit and margin that follow. Three
 * more come from the project row when a person has filled them in: contracted
 * revenue, invoiced revenue, budgeted expense.
 *
 * The remaining ones - allocated employee labour, software allocated to a
 * project - need an allocation model and time data that do not exist yet
 * (section 13, still unbuilt). They are reported as ABSENT rather than as
 * zero. A project showing zero allocated labour reads as "this project used
 * nobody's time", which for a services business is never true, and it would
 * flatter every margin on the page.
 */

import type { Transaction } from '@/lib/types';
import { countsTowardPnl, usdMinorOf, IDENTITY_RATES, type UsdRateMap } from '@/lib/calc/engine';
import type { ISODate } from '@/lib/dates';

export interface ProjectFinancials {
  /** Human-supplied on the project row; null when nobody has said. */
  contractedRevenueUsdMinor: number | null;
  invoicedRevenueUsdMinor: number | null;
  budgetExpenseUsdMinor: number | null;

  /** Straight from the ledger. */
  cashReceivedUsdMinor: number;
  directExpenseUsdMinor: number;

  /** Cash in less direct cost. The only profit the ledger alone can support. */
  grossProfitUsdMinor: number;
  /** Gross profit over cash received; null when nothing has been received. */
  grossMarginRatio: number | null;

  /** Spec 14: net profit over total expense. Null when nothing was spent. */
  roiRatio: number | null;

  /** invoiced - received. Null unless somebody recorded what was invoiced. */
  outstandingUsdMinor: number | null;
  /** contracted - invoiced: work sold but not yet billed. */
  unbilledUsdMinor: number | null;
  /** actual - budget. Positive is an overspend. */
  budgetVarianceUsdMinor: number | null;

  transactionCount: number;
  firstActivity: ISODate | null;
  lastActivity: ISODate | null;

  /**
   * Costs section 12 asks for that nothing in the system can yet answer.
   *
   * Carried on the result so a page can say so out loud instead of printing a
   * confident zero.
   */
  missingCostTypes: readonly ['allocated_labour', 'allocated_software'];
}

export interface CategoryLine {
  category: string;
  amountUsdMinor: number;
  /** Share of the revenue or expense side this line makes up, 0-1. */
  shareOfSide: number;
  transactionCount: number;
}

export interface ProjectPnl extends ProjectFinancials {
  revenueByCategory: CategoryLine[];
  expenseByCategory: CategoryLine[];
}

/** What a project row has to carry for the human-supplied half. */
export interface ProjectTargets {
  contracted_revenue_minor?: number | null;
  invoiced_revenue_minor?: number | null;
  budget_expense_minor?: number | null;
}

/**
 * The P&L for one project, from the transactions assigned to it.
 *
 * Callers pass only that project's rows. Internal transfers and flagged
 * duplicates are dropped here as everywhere else: funding a project account
 * from the operating account is not revenue, and a duplicated invoice payment
 * would report profit that never existed.
 */
export function computeProjectPnl(
  transactions: Transaction[],
  targets: ProjectTargets = {},
  rates: UsdRateMap = IDENTITY_RATES,
): ProjectPnl {
  const rows = transactions.filter(countsTowardPnl);

  let cashReceived = 0;
  let directExpense = 0;
  let firstActivity: ISODate | null = null;
  let lastActivity: ISODate | null = null;

  const revenueTally = new Map<string, { amount: number; count: number }>();
  const expenseTally = new Map<string, { amount: number; count: number }>();

  for (const t of rows) {
    const usd = usdMinorOf(t, rates);
    const side = t.direction === 'inflow' ? revenueTally : expenseTally;
    const key = t.category ?? 'uncategorized';
    const entry = side.get(key);
    if (entry) {
      entry.amount += usd;
      entry.count += 1;
    } else {
      side.set(key, { amount: usd, count: 1 });
    }

    if (t.direction === 'inflow') cashReceived += usd;
    else directExpense += usd;

    if (firstActivity === null || t.txn_date < firstActivity) firstActivity = t.txn_date;
    if (lastActivity === null || t.txn_date > lastActivity) lastActivity = t.txn_date;
  }

  const grossProfit = cashReceived - directExpense;

  const contracted = targets.contracted_revenue_minor ?? null;
  const invoiced = targets.invoiced_revenue_minor ?? null;
  const budget = targets.budget_expense_minor ?? null;

  return {
    contractedRevenueUsdMinor: contracted,
    invoicedRevenueUsdMinor: invoiced,
    budgetExpenseUsdMinor: budget,

    cashReceivedUsdMinor: cashReceived,
    directExpenseUsdMinor: directExpense,
    grossProfitUsdMinor: grossProfit,
    // Dividing by zero received would report an infinite margin on a project
    // that has taken no money. Null says "not yet answerable", which is true.
    grossMarginRatio: cashReceived > 0 ? grossProfit / cashReceived : null,
    roiRatio: directExpense > 0 ? grossProfit / directExpense : null,

    outstandingUsdMinor: invoiced === null ? null : invoiced - cashReceived,
    unbilledUsdMinor: contracted === null || invoiced === null ? null : contracted - invoiced,
    budgetVarianceUsdMinor: budget === null ? null : directExpense - budget,

    transactionCount: rows.length,
    firstActivity,
    lastActivity,

    missingCostTypes: MISSING_COST_TYPES,

    revenueByCategory: toLines(revenueTally, cashReceived),
    expenseByCategory: toLines(expenseTally, directExpense),
  };
}

const MISSING_COST_TYPES = ['allocated_labour', 'allocated_software'] as const;

function toLines(
  tally: Map<string, { amount: number; count: number }>,
  sideTotal: number,
): CategoryLine[] {
  return [...tally]
    .map(([category, { amount, count }]) => ({
      category,
      amountUsdMinor: amount,
      shareOfSide: sideTotal > 0 ? amount / sideTotal : 0,
      transactionCount: count,
    }))
    .sort((a, b) => b.amountUsdMinor - a.amountUsdMinor);
}

// ─── Portfolio roll-up (spec 16) ────────────────────────────────────────────

export interface ProjectSummaryRow<P extends { id: string }> {
  project: P;
  pnl: ProjectPnl;
}

export interface PortfolioTotals {
  cashReceivedUsdMinor: number;
  directExpenseUsdMinor: number;
  grossProfitUsdMinor: number;
  grossMarginRatio: number | null;
  projectCount: number;
  /** Projects whose direct costs exceed what they have brought in. */
  lossMakingCount: number;
  /** Assigned to no project at all - see `unassignedTotals`. */
  unassignedCount: number;
}

/**
 * Group transactions by project and compute each P&L in one pass.
 *
 * Rows with no `project_id` are returned separately rather than dropped. An
 * overhead that belongs to no project is normal and correct - spec 16 separates
 * direct costs from allocated ones - but a page that silently omits them lets
 * the sum of every project P&L disagree with the company P&L, with nothing on
 * screen to explain the gap.
 */
export function groupByProject<P extends { id: string } & ProjectTargets>(
  projects: P[],
  transactions: Array<Transaction & { project_id?: string | null }>,
  rates: UsdRateMap = IDENTITY_RATES,
): { rows: Array<ProjectSummaryRow<P>>; unassigned: Transaction[] } {
  const byProject = new Map<string, Transaction[]>();
  const unassigned: Transaction[] = [];

  for (const t of transactions) {
    const id = t.project_id ?? null;
    if (!id) {
      unassigned.push(t);
      continue;
    }
    const list = byProject.get(id);
    if (list) list.push(t);
    else byProject.set(id, [t]);
  }

  const rows = projects.map((project) => ({
    project,
    pnl: computeProjectPnl(byProject.get(project.id) ?? [], project, rates),
  }));

  return { rows, unassigned };
}

export function portfolioTotals<P extends { id: string }>(
  rows: Array<ProjectSummaryRow<P>>,
  unassigned: Transaction[] = [],
): PortfolioTotals {
  let cashReceived = 0;
  let directExpense = 0;
  let lossMaking = 0;

  for (const { pnl } of rows) {
    cashReceived += pnl.cashReceivedUsdMinor;
    directExpense += pnl.directExpenseUsdMinor;
    // Only counts as loss-making once there has been activity: a project that
    // has neither spent nor received anything is not losing money, it has not
    // started.
    if (pnl.transactionCount > 0 && pnl.grossProfitUsdMinor < 0) lossMaking++;
  }

  const grossProfit = cashReceived - directExpense;

  return {
    cashReceivedUsdMinor: cashReceived,
    directExpenseUsdMinor: directExpense,
    grossProfitUsdMinor: grossProfit,
    grossMarginRatio: cashReceived > 0 ? grossProfit / cashReceived : null,
    projectCount: rows.length,
    lossMakingCount: lossMaking,
    unassignedCount: unassigned.filter(countsTowardPnl).length,
  };
}

// ─── Roll-up by any dimension (spec 16) ─────────────────────────────────────

/**
 * The dimensions spec 16 asks to see profitability by.
 *
 * `kind` splits projects from events, which section 14 treats as a reporting
 * split in its own right.
 */
export type RollupDimension = 'business_unit' | 'service' | 'client' | 'kind' | 'status';

export interface RollupGroup {
  key: string;
  label: string;
  cashReceivedUsdMinor: number;
  directExpenseUsdMinor: number;
  grossProfitUsdMinor: number;
  grossMarginRatio: number | null;
  projectCount: number;
  lossMakingCount: number;

  /**
   * Labour charged to this group from logged hours.
   *
   * NULL, not zero, when the reader may not see compensation or when no
   * lookup was supplied. Zero would say "these people cost nothing", which is
   * the confident zero decision 90 was about; null says "not counted here".
   */
  labourUsdMinor: number | null;
  /** Gross profit less labour. Null whenever `labourUsdMinor` is. */
  profitAfterLabourUsdMinor: number | null;
}

interface RollupSource {
  business_unit?: { name: string } | null;
  business_unit_id?: string | null;
  service?: string | null;
  client?: { name: string } | null;
  client_id?: string | null;
  kind?: string;
  status?: string;
}

/**
 * Group project P&Ls by one dimension - Spec section 16.
 *
 * Rolls up the SAME numbers the individual P&Ls show, by summing them rather
 * than re-reading the ledger. A roll-up computed independently is a second
 * implementation of the same arithmetic, and the first time the two disagree
 * nobody can tell which one is wrong.
 *
 * Rows with nothing in the dimension land in an explicit "Unassigned" group
 * instead of being dropped, so every group total still adds back to the
 * portfolio total.
 */
export function rollUpBy<P extends { id: string } & RollupSource>(
  rows: Array<ProjectSummaryRow<P>>,
  dimension: RollupDimension,
  /**
   * What each project's logged hours cost, if the reader may know.
   *
   * Optional so that every existing caller keeps its exact behaviour and gets
   * `labourUsdMinor: null` — "not counted" rather than "counted as nothing".
   */
  labourFor?: (projectId: string) => number,
): RollupGroup[] {
  const groups = new Map<string, RollupGroup>();

  for (const { project, pnl } of rows) {
    const { key, label } = dimensionOf(project, dimension);
    const group =
      groups.get(key) ??
      {
        key,
        label,
        cashReceivedUsdMinor: 0,
        directExpenseUsdMinor: 0,
        grossProfitUsdMinor: 0,
        grossMarginRatio: null,
        projectCount: 0,
        lossMakingCount: 0,
        labourUsdMinor: labourFor ? 0 : null,
        profitAfterLabourUsdMinor: null,
      };

    group.cashReceivedUsdMinor += pnl.cashReceivedUsdMinor;
    group.directExpenseUsdMinor += pnl.directExpenseUsdMinor;
    group.grossProfitUsdMinor += pnl.grossProfitUsdMinor;
    group.projectCount += 1;
    if (labourFor) group.labourUsdMinor = (group.labourUsdMinor ?? 0) + labourFor(project.id);
    if (pnl.transactionCount > 0 && pnl.grossProfitUsdMinor < 0) group.lossMakingCount += 1;

    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.grossMarginRatio =
      group.cashReceivedUsdMinor > 0
        ? group.grossProfitUsdMinor / group.cashReceivedUsdMinor
        : null;
    group.profitAfterLabourUsdMinor =
      group.labourUsdMinor === null ? null : group.grossProfitUsdMinor - group.labourUsdMinor;
  }

  return [...groups.values()].sort((a, b) => b.cashReceivedUsdMinor - a.cashReceivedUsdMinor);
}

function dimensionOf(
  project: RollupSource,
  dimension: RollupDimension,
): { key: string; label: string } {
  switch (dimension) {
    case 'business_unit':
      return project.business_unit?.name
        ? { key: project.business_unit_id ?? project.business_unit.name, label: project.business_unit.name }
        : UNASSIGNED;
    case 'service':
      return project.service ? { key: project.service, label: project.service } : UNASSIGNED;
    case 'client':
      return project.client?.name
        ? { key: project.client_id ?? project.client.name, label: project.client.name }
        : UNASSIGNED;
    case 'kind':
      return { key: project.kind ?? 'project', label: project.kind === 'event' ? 'Events' : 'Projects' };
    case 'status': {
      // `kind` two lines up returns "Projects"/"Events"; returning a raw enum
      // here put "active" and "completed" in the same column as properly
      // written labels. `label` is display text or it is nothing.
      const status = project.status ?? 'active';
      return { key: status, label: STATUS_LABELS[status] ?? status };
    }
  }
}

const STATUS_LABELS: Record<string, string> = {
  planned: 'Planned',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const UNASSIGNED = { key: '__unassigned__', label: 'Not set' } as const;
