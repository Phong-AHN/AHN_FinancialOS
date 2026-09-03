/**
 * Labour cost on projects - Spec section 13.
 *
 * Pure functions. Given people, their time entries and the project they were
 * logged against, this answers what the work cost.
 *
 * THE DOUBLE-COUNT THIS FILE EXISTS TO PREVENT.
 *
 * Payroll has already left the bank. It sits in the ledger as outflows to Gusto
 * and lands in the company P&L as overhead. Labour cost computed from time
 * entries is an ALLOCATION of that same money onto the projects that consumed
 * it - it is not a second cost.
 *
 * So a project's net profit is `gross profit - allocated labour`, and that is
 * only correct while the payroll transactions themselves stay unattributed. The
 * moment somebody attributes a Gusto payment to a project AND logs hours
 * against it, that project pays for the same people twice. Nothing in the
 * database can stop that, so `detectLabourDoubleCount` finds it and the pages
 * say so out loud rather than quietly reporting a worse project than exists.
 */

import type { Transaction } from '@/lib/types';
import { countsTowardPnl, usdMinorOf, IDENTITY_RATES, type UsdRateMap } from '@/lib/calc/engine';
import type { ISODate } from '@/lib/dates';

export type CostBasis = 'salaried' | 'hourly' | 'contractor_rate';

export interface Person {
  id: string;
  name: string;
  kind: 'employee' | 'contractor';
  basis: CostBasis;
  annual_cost_minor: number | null;
  hourly_cost_minor: number | null;
  annual_hours: number;
  currency: string;
}

export interface TimeEntry {
  id: string;
  person_id: string;
  project_id: string;
  work_date: ISODate;
  hours: number;
}

/**
 * What one hour of this person costs, in minor units.
 *
 * The three bases in spec section 13 all collapse to this number. A salaried
 * person's hour is their loaded annual cost over the hours they are actually
 * available - dividing by a hardcoded 2,080 would price every hour as though
 * nobody ever took leave, understating each one by about a tenth.
 *
 * Returns null rather than zero when the rate is unknowable. A zero would make
 * that person's time free, and free time silently improves every project they
 * touch.
 */
export function hourlyCostOf(person: Person): number | null {
  if (person.basis === 'salaried') {
    if (person.annual_cost_minor === null || person.annual_hours <= 0) return null;
    return person.annual_cost_minor / person.annual_hours;
  }
  return person.hourly_cost_minor ?? null;
}

export interface PersonLabour {
  person: Person;
  hours: number;
  costUsdMinor: number;
  /** True when this person has no usable rate, so their hours cost nothing. */
  rateUnknown: boolean;
}

export interface ProjectLabour {
  actualHours: number;
  actualCostUsdMinor: number;

  /** Human-supplied on the project row; null when nobody has estimated. */
  estimatedHours: number | null;
  labourBudgetUsdMinor: number | null;

  /** actual - estimate. Positive means it took longer than planned. */
  hoursVariance: number | null;
  /** actual - budget. Positive is an overspend. */
  costVarianceUsdMinor: number | null;

  byPerson: PersonLabour[];
  /**
   * Hours logged by people whose rate is unknown.
   *
   * Their time is real and its cost is not counted, so a page reporting labour
   * cost has to disclose this or the figure reads as complete when it is not.
   */
  unpricedHours: number;

  firstEntry: ISODate | null;
  lastEntry: ISODate | null;
}

export interface LabourTargets {
  estimated_hours?: number | null;
  labour_budget_minor?: number | null;
}

/**
 * Labour spent on one project.
 *
 * Callers pass only that project's time entries. Rates are resolved per person
 * once, not per entry.
 */
export function computeProjectLabour(
  entries: TimeEntry[],
  people: Person[],
  targets: LabourTargets = {},
): ProjectLabour {
  const byId = new Map(people.map((p) => [p.id, p]));
  const tally = new Map<string, { hours: number; cost: number }>();

  let actualHours = 0;
  let actualCost = 0;
  let unpricedHours = 0;
  let firstEntry: ISODate | null = null;
  let lastEntry: ISODate | null = null;

  for (const entry of entries) {
    const person = byId.get(entry.person_id);
    if (!person) continue;

    const rate = hourlyCostOf(person);
    // Round at the person's total, not per entry: rounding every daily line
    // then summing drifts by a cent per entry, and a year of daily timesheets
    // is a few dollars of drift for no reason.
    const cost = rate === null ? 0 : rate * entry.hours;

    const acc = tally.get(person.id) ?? { hours: 0, cost: 0 };
    acc.hours += entry.hours;
    acc.cost += cost;
    tally.set(person.id, acc);

    actualHours += entry.hours;
    actualCost += cost;
    if (rate === null) unpricedHours += entry.hours;

    if (firstEntry === null || entry.work_date < firstEntry) firstEntry = entry.work_date;
    if (lastEntry === null || entry.work_date > lastEntry) lastEntry = entry.work_date;
  }

  const byPerson: PersonLabour[] = [...tally]
    .map(([personId, acc]) => {
      const person = byId.get(personId)!;
      return {
        person,
        hours: round2(acc.hours),
        costUsdMinor: Math.round(acc.cost),
        rateUnknown: hourlyCostOf(person) === null,
      };
    })
    .sort((a, b) => b.costUsdMinor - a.costUsdMinor);

  const estimatedHours = targets.estimated_hours ?? null;
  const labourBudget = targets.labour_budget_minor ?? null;
  const roundedCost = Math.round(actualCost);

  return {
    actualHours: round2(actualHours),
    actualCostUsdMinor: roundedCost,
    estimatedHours,
    labourBudgetUsdMinor: labourBudget,
    hoursVariance: estimatedHours === null ? null : round2(actualHours - estimatedHours),
    costVarianceUsdMinor: labourBudget === null ? null : roundedCost - labourBudget,
    byPerson,
    unpricedHours: round2(unpricedHours),
    firstEntry,
    lastEntry,
  };
}

/**
 * Net project profit, after the labour the project consumed - Spec section 12.
 *
 * Gross profit already nets direct costs out of cash received. This subtracts
 * the allocated labour on top, which is the figure section 12 calls net project
 * profit and the one a decision should actually be made on.
 */
export interface NetProfit {
  netProfitUsdMinor: number;
  netMarginRatio: number | null;
  /** How much of the gross profit the labour consumed, 0-1. */
  labourShareOfGross: number | null;
}

export function computeNetProfit(
  grossProfitUsdMinor: number,
  cashReceivedUsdMinor: number,
  labourCostUsdMinor: number,
): NetProfit {
  const net = grossProfitUsdMinor - labourCostUsdMinor;
  return {
    netProfitUsdMinor: net,
    netMarginRatio: cashReceivedUsdMinor > 0 ? net / cashReceivedUsdMinor : null,
    labourShareOfGross:
      grossProfitUsdMinor > 0 ? labourCostUsdMinor / grossProfitUsdMinor : null,
  };
}

// ─── The double count ───────────────────────────────────────────────────────

export interface DoubleCountWarning {
  /** Payroll transactions attributed straight to the project. */
  attributedPayrollUsdMinor: number;
  transactionCount: number;
  /** Labour allocated to the same project from time entries. */
  allocatedLabourUsdMinor: number;
}

/**
 * Find a project paying for the same people twice.
 *
 * A project with hours logged against it AND a payroll transaction attributed
 * to it counts that payroll once as a direct cost and again as allocated
 * labour. The result is a project that looks far less profitable than it is,
 * and nothing on the page would explain why.
 *
 * Returns null when there is no overlap, so a caller can render nothing in the
 * ordinary case.
 */
export function detectLabourDoubleCount(
  projectTransactions: Transaction[],
  labourCostUsdMinor: number,
  rates: UsdRateMap = IDENTITY_RATES,
): DoubleCountWarning | null {
  if (labourCostUsdMinor <= 0) return null;

  const payroll = projectTransactions.filter(
    (t) => t.direction === 'outflow' && countsTowardPnl(t) && isPayroll(t),
  );
  if (payroll.length === 0) return null;

  return {
    attributedPayrollUsdMinor: payroll.reduce((s, t) => s + usdMinorOf(t, rates), 0),
    transactionCount: payroll.length,
    allocatedLabourUsdMinor: labourCostUsdMinor,
  };
}

/**
 * Whether a transaction is somebody being paid.
 *
 * Matches the `people` category the categoriser assigns, and the subcategories
 * beneath it. Kept in step with `is_sensitive_transaction` in migration 0007 -
 * the same rows that are hidden from viewers are the ones that would double
 * count here, because both questions are really "is this compensation?".
 */
function isPayroll(t: Pick<Transaction, 'category' | 'subcategory'>): boolean {
  if (t.category === 'people') return true;
  const text = `${t.category ?? ''} ${t.subcategory ?? ''}`.toLowerCase();
  return /payroll|salary|wage|bonus|commission|compensation|contractor_pay/.test(text);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
