/**
 * Budget vs. actual - Spec section 19.
 *
 * Pure functions. Section 19 asks for six figures: budget, actual, remaining,
 * variance %, projected final cost, and an alert before overspend occurs.
 *
 * FIVE OF THOSE ARE ARITHMETIC. The sixth - the projection - is a guess about
 * the future, and it is the one a budget page gets wrong in the direction that
 * matters. Two days into a month, one large payment makes a run-rate projection
 * read fifteen times the budget; a page that prints that number teaches its
 * reader to ignore the column. So `projectedFinalUsdMinor` comes with
 * `projectionConfidence`, and a caller that shows the figure without the
 * confidence is showing noise.
 */

import type { Transaction } from '@/lib/types';
import { countsTowardPnl, usdMinorOf, IDENTITY_RATES, type UsdRateMap } from '@/lib/calc/engine';
import { addDays, addMonths, daysBetween, monthStart, type ISODate } from '@/lib/dates';

export type BudgetScope =
  | 'company'
  | 'business_unit'
  | 'client'
  | 'project'
  | 'category'
  /**
   * Spec 19's own word. A department owns section 7 spend categories rather
   * than carrying a tag on every transaction, so its spend is answerable from
   * data that already exists. See migration 0035.
   */
  | 'department'
  | 'total';

export type BudgetPeriod = 'month' | 'quarter' | 'year';

export interface BudgetRow {
  id: string;
  name: string;
  scope: BudgetScope;
  scope_id: string | null;
  scope_key: string | null;
  period: BudgetPeriod;
  starts_on: ISODate;
  amount_minor: number;
  currency: string;
  is_active: boolean;
}

/** The last day the period covers, derived rather than stored. */
export function periodEnd(starts: ISODate, period: BudgetPeriod): ISODate {
  const months = period === 'month' ? 1 : period === 'quarter' ? 3 : 12;
  return addDays(addMonths(starts, months), -1);
}

export interface PeriodProgress {
  daysElapsed: number;
  daysTotal: number;
  /** 0 before the period starts, 1 once it has ended. */
  fractionElapsed: number;
  hasEnded: boolean;
}

/**
 * How far through the period `asOf` is.
 *
 * Counts the day itself as elapsed, because a payment made today is already
 * spent. Off-by-one here quietly shifts every projection.
 */
export function periodProgress(
  starts: ISODate,
  period: BudgetPeriod,
  asOf: ISODate,
): PeriodProgress {
  const ends = periodEnd(starts, period);
  const daysTotal = daysBetween(starts, ends) + 1;

  if (asOf < starts) {
    return { daysElapsed: 0, daysTotal, fractionElapsed: 0, hasEnded: false };
  }
  if (asOf >= ends) {
    return { daysElapsed: daysTotal, daysTotal, fractionElapsed: 1, hasEnded: true };
  }

  const daysElapsed = daysBetween(starts, asOf) + 1;
  return { daysElapsed, daysTotal, fractionElapsed: daysElapsed / daysTotal, hasEnded: false };
}

/**
 * How much a run-rate projection can be trusted, 0-1.
 *
 * Two things make it worthless, and both are common:
 *
 *   - TOO EARLY. A tenth of the way through a period, the remaining nine tenths
 *     are extrapolated from one tenth of the evidence. One large payment on day
 *     two is enough to project a catastrophic overspend that never happens.
 *   - TOO LUMPY. Spending concentrated in a handful of payments does not
 *     average out over the rest of the period the way a run rate assumes.
 *
 * Returns 1 once the period has ended, because then it is not a projection at
 * all - it is the actual.
 */
export function projectionConfidence(
  progress: PeriodProgress,
  transactionCount: number,
): number {
  if (progress.hasEnded) return 1;
  if (progress.fractionElapsed <= 0) return 0;

  // Below a quarter of the way through, confidence climbs from nothing;
  // by half way, elapsed time stops being the limiting factor.
  const byTime = Math.min(1, progress.fractionElapsed / 0.5);

  // One payment is not a run rate. Eight or more starts to behave like one.
  const byVolume = Math.min(1, transactionCount / 8);

  return round2(byTime * byVolume);
}

export interface BudgetStatus {
  budget: BudgetRow;
  periodStart: ISODate;
  periodEnd: ISODate;
  progress: PeriodProgress;

  budgetUsdMinor: number;
  actualUsdMinor: number;
  /** budget - actual. Negative once it is overspent. */
  remainingUsdMinor: number;
  /** (actual - budget) / budget. Positive is over. Null on a zero budget. */
  varianceRatio: number | null;

  /**
   * What the period ends at if the rest of it looks like the part so far.
   *
   * Read `projectionConfidence` before showing this to anyone.
   */
  projectedFinalUsdMinor: number;
  projectionConfidence: number;

  /** True when the projection clears the budget but the actual has not yet. */
  projectedToOverspend: boolean;
  /** True when it already has. */
  overspent: boolean;

  transactionCount: number;
  transactionIds: string[];
}

/** What decides whether a transaction belongs to a budget's scope. */
export interface ScopeContext {
  /** Transaction id -> the project it is attributed to. */
  projectOf?: Map<string, string | null>;
  /** Project id -> its business unit and client. */
  projectMeta?: Map<string, { businessUnitId: string | null; clientId: string | null }>;
  /**
   * Department id → the section 7 categories it owns.
   *
   * Passed in rather than queried here so this file stays pure: the same
   * inputs give the same answer on any machine.
   */
  departmentCategories?: Map<string, Set<string>>;
  /** Account id -> the company that owns it. */
  companyOfAccount?: Map<string, string | null>;
}

/**
 * Whether one transaction counts against one budget.
 *
 * Only outflows that count toward P&L. A budget is about spending: an internal
 * transfer is not spending, and a flagged duplicate is spending that did not
 * happen.
 */
export function matchesScope(
  txn: Transaction & { project_id?: string | null },
  budget: Pick<BudgetRow, 'scope' | 'scope_id' | 'scope_key'>,
  context: ScopeContext = {},
): boolean {
  if (txn.direction !== 'outflow' || !countsTowardPnl(txn)) return false;

  switch (budget.scope) {
    case 'total':
      return true;

    case 'category':
      return (txn.category ?? 'uncategorized') === budget.scope_key;

    case 'department': {
      // A department owns a set of categories. Migration 0035 guarantees no
      // category belongs to two, so no dollar is counted against two budgets.
      const owned = context.departmentCategories?.get(budget.scope_id ?? '');
      if (!owned) return false;
      return owned.has(txn.category ?? 'uncategorized');
    }

    case 'project':
      return (txn.project_id ?? context.projectOf?.get(txn.id) ?? null) === budget.scope_id;

    case 'business_unit': {
      const projectId = txn.project_id ?? context.projectOf?.get(txn.id) ?? null;
      if (!projectId) return false;
      return context.projectMeta?.get(projectId)?.businessUnitId === budget.scope_id;
    }

    case 'client': {
      const projectId = txn.project_id ?? context.projectOf?.get(txn.id) ?? null;
      if (!projectId) return false;
      return context.projectMeta?.get(projectId)?.clientId === budget.scope_id;
    }

    case 'company':
      return context.companyOfAccount?.get(txn.account_id) === budget.scope_id;
  }
}

/**
 * One budget, measured against the ledger.
 *
 * The caller passes every transaction; this filters to the period and the
 * scope. Filtering here rather than in the query keeps one definition of
 * "counts against this budget" instead of one per call site.
 */
export function computeBudgetStatus(
  budget: BudgetRow,
  transactions: Array<Transaction & { project_id?: string | null }>,
  asOf: ISODate,
  context: ScopeContext = {},
  rates: UsdRateMap = IDENTITY_RATES,
): BudgetStatus {
  const ends = periodEnd(budget.starts_on, budget.period);
  const progress = periodProgress(budget.starts_on, budget.period, asOf);

  let actual = 0;
  const ids: string[] = [];

  for (const txn of transactions) {
    if (txn.txn_date < budget.starts_on || txn.txn_date > ends) continue;
    // Spending that has not happened yet is not spending. Without this a
    // future-dated row would count against a period it has not reached.
    if (txn.txn_date > asOf) continue;
    if (!matchesScope(txn, budget, context)) continue;

    actual += usdMinorOf(txn, rates);
    ids.push(txn.id);
  }

  const budgetAmount = budget.amount_minor;
  const remaining = budgetAmount - actual;

  // Straight-line run rate. Once the period is over there is nothing left to
  // project, so the actual IS the final.
  const projected =
    progress.fractionElapsed > 0
      ? Math.round(actual / progress.fractionElapsed)
      : 0;
  const projectedFinal = progress.hasEnded ? actual : projected;

  return {
    budget,
    periodStart: budget.starts_on,
    periodEnd: ends,
    progress,
    budgetUsdMinor: budgetAmount,
    actualUsdMinor: actual,
    remainingUsdMinor: remaining,
    // A zero budget makes every variance infinite. Null says "not answerable",
    // which is what it is.
    varianceRatio: budgetAmount > 0 ? (actual - budgetAmount) / budgetAmount : null,
    projectedFinalUsdMinor: projectedFinal,
    projectionConfidence: projectionConfidence(progress, ids.length),
    projectedToOverspend: actual <= budgetAmount && projectedFinal > budgetAmount,
    overspent: actual > budgetAmount,
    transactionCount: ids.length,
    transactionIds: ids,
  };
}

// ─── Portfolio ──────────────────────────────────────────────────────────────

export interface BudgetTotals {
  budgetUsdMinor: number;
  actualUsdMinor: number;
  remainingUsdMinor: number;
  count: number;
  overspentCount: number;
  /** Heading for an overspend but not there yet — the ones worth acting on. */
  atRiskCount: number;
}

/**
 * Sums across budgets, with one deliberate omission.
 *
 * There is no combined "projected" total. Budgets overlap by design - a
 * category budget and a business-unit budget can cover the same payment - so
 * adding their projections would double-count, and the resulting figure would
 * look authoritative while meaning nothing. Overlap is fine per budget and
 * wrong in a sum.
 */
export function budgetTotals(statuses: BudgetStatus[]): BudgetTotals {
  let budget = 0;
  let actual = 0;
  let overspent = 0;
  let atRisk = 0;

  for (const s of statuses) {
    budget += s.budgetUsdMinor;
    actual += s.actualUsdMinor;
    if (s.overspent) overspent++;
    // Only counted when the projection is worth believing.
    else if (s.projectedToOverspend && s.projectionConfidence >= 0.5) atRisk++;
  }

  return {
    budgetUsdMinor: budget,
    actualUsdMinor: actual,
    remainingUsdMinor: budget - actual,
    count: statuses.length,
    overspentCount: overspent,
    atRiskCount: atRisk,
  };
}

/** The period containing `asOf`, aligned to calendar boundaries. */
export function currentPeriodStart(asOf: ISODate, period: BudgetPeriod): ISODate {
  const month = monthStart(asOf);
  if (period === 'month') return month;

  const monthIndex = Number(month.slice(5, 7)) - 1;
  const year = month.slice(0, 4);
  if (period === 'quarter') {
    const firstMonth = Math.floor(monthIndex / 3) * 3 + 1;
    return `${year}-${String(firstMonth).padStart(2, '0')}-01`;
  }
  return `${year}-01-01`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
