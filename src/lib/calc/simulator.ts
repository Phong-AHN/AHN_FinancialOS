/**
 * Revenue growth and margin simulator - Spec section 11.
 *
 * Pure functions. Given the months the company has actually had, this projects
 * the months it is aiming for.
 *
 * THESE ARE TARGETS, NOT FORECASTS. Section 11 asks the user to *set* a growth
 * rate; the system works out what that implies. Nothing here predicts what will
 * happen, and every function is named so a caller cannot accidentally present
 * one as the other.
 *
 * Two things this file refuses to do, because both are how a projection starts
 * lying:
 *
 *   1. Grow revenue while holding costs still. A plan that triples revenue on
 *      today's cost base is not a plan, and `expenseGrowthRate` has no default
 *      that quietly means zero - the caller has to choose.
 *
 *   2. Build on a baseline without saying how solid it is. One good month as
 *      the base makes every later month a fantasy compounded twelve times, so
 *      the baseline carries its own volatility and the months it came from.
 */

import { addMonths, type ISODate } from '@/lib/dates';

export interface MonthlyActual {
  month: ISODate;
  inflowUsdMinor: number;
  outflowUsdMinor: number;
}

export interface Baseline {
  /** Trailing average monthly revenue over the complete months sampled. */
  revenueUsdMinor: number;
  expenseUsdMinor: number;
  monthsSampled: number;
  /** The most recent complete month, which every projection starts after. */
  lastMonth: ISODate | null;

  /**
   * How much monthly revenue moves around its own average, 0 upward.
   *
   * The coefficient of variation: standard deviation over the mean. Below ~0.3
   * the average is a fair description of a typical month; above ~0.6 there is
   * no typical month, and a growth plan compounded off that average inherits
   * the noise rather than the trend.
   */
  revenueVolatility: number | null;

  /** Month-over-month revenue changes actually observed, oldest first. */
  observedGrowth: number[];
}

/**
 * What the company has actually been doing, from complete months only.
 *
 * A partial current month would drag the average down for no reason other than
 * the calendar, and every target derived from it would be set too low.
 */
export function computeBaseline(months: MonthlyActual[]): Baseline {
  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));

  if (sorted.length === 0) {
    return {
      revenueUsdMinor: 0,
      expenseUsdMinor: 0,
      monthsSampled: 0,
      lastMonth: null,
      revenueVolatility: null,
      observedGrowth: [],
    };
  }

  const revenues = sorted.map((m) => m.inflowUsdMinor);
  const meanRevenue = revenues.reduce((s, v) => s + v, 0) / revenues.length;
  const meanExpense =
    sorted.reduce((s, m) => s + m.outflowUsdMinor, 0) / sorted.length;

  const observedGrowth: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!.inflowUsdMinor;
    // A month with no revenue gives no growth rate - the change from zero is
    // undefined, not infinite, and treating it as infinite would poison the
    // scenario presets built from these numbers.
    if (previous <= 0) continue;
    observedGrowth.push((sorted[i]!.inflowUsdMinor - previous) / previous);
  }

  return {
    revenueUsdMinor: Math.round(meanRevenue),
    expenseUsdMinor: Math.round(meanExpense),
    monthsSampled: sorted.length,
    lastMonth: sorted[sorted.length - 1]!.month,
    revenueVolatility:
      revenues.length > 1 && meanRevenue > 0
        ? standardDeviation(revenues) / meanRevenue
        : null,
    observedGrowth,
  };
}

// ─── Growth-driven projection ───────────────────────────────────────────────

export interface ProjectedMonth {
  month: ISODate;
  /** 1 for the first projected month, 2 for the next, and so on. */
  monthIndex: number;
  revenueTargetUsdMinor: number;
  expenseForecastUsdMinor: number;
  profitUsdMinor: number;
  marginRatio: number | null;
  /** Cumulative revenue target from the first projected month to this one. */
  cumulativeRevenueUsdMinor: number;
}

export interface GrowthScenarioInput {
  baseline: Baseline;
  /** Month-over-month revenue growth, as a ratio: 0.15 is +15%. */
  revenueGrowthRate: number;
  /**
   * Month-over-month expense growth. REQUIRED, with no default.
   *
   * A projection that grows revenue and holds costs flat is the single most
   * flattering mistake available here, and a default of zero would make it the
   * easy one to make by accident.
   */
  expenseGrowthRate: number;
  months: number;
}

export interface GrowthProjection {
  months: ProjectedMonth[];
  /** What the final month's revenue is as a multiple of the baseline. */
  finalMultiple: number;
  totalRevenueUsdMinor: number;
  totalExpenseUsdMinor: number;
  totalProfitUsdMinor: number;
  /** The first month the projection turns a profit; null if it never does. */
  breakEvenMonth: ISODate | null;
}

/**
 * Compound a growth rate forward from the baseline - Spec section 11.
 *
 * Compounding is the point and also the trap: +15% a month is not +180% a year,
 * it is +435%. `finalMultiple` is returned so a page can put that number in
 * front of whoever picked the rate.
 */
export function projectGrowth(input: GrowthScenarioInput): GrowthProjection {
  const { baseline, revenueGrowthRate, expenseGrowthRate } = input;
  const months = Math.max(0, Math.floor(input.months));

  const rows: ProjectedMonth[] = [];
  let cumulative = 0;
  let totalExpense = 0;
  let breakEvenMonth: ISODate | null = null;

  for (let i = 1; i <= months; i++) {
    const revenue = Math.round(baseline.revenueUsdMinor * Math.pow(1 + revenueGrowthRate, i));
    const expense = Math.round(baseline.expenseUsdMinor * Math.pow(1 + expenseGrowthRate, i));
    const profit = revenue - expense;
    cumulative += revenue;
    totalExpense += expense;

    if (breakEvenMonth === null && profit > 0) {
      breakEvenMonth = baseline.lastMonth ? addMonths(baseline.lastMonth, i) : null;
    }

    rows.push({
      month: baseline.lastMonth ? addMonths(baseline.lastMonth, i) : `+${i}`,
      monthIndex: i,
      revenueTargetUsdMinor: revenue,
      expenseForecastUsdMinor: expense,
      profitUsdMinor: profit,
      marginRatio: revenue > 0 ? profit / revenue : null,
      cumulativeRevenueUsdMinor: cumulative,
    });
  }

  return {
    months: rows,
    finalMultiple: months > 0 ? Math.pow(1 + revenueGrowthRate, months) : 1,
    totalRevenueUsdMinor: cumulative,
    totalExpenseUsdMinor: totalExpense,
    totalProfitUsdMinor: cumulative - totalExpense,
    breakEvenMonth,
  };
}

// ─── Margin-driven projection ───────────────────────────────────────────────

export interface MarginTargetResult {
  /** Revenue needed for the target margin against the forecast expense. */
  requiredRevenueUsdMinor: number | null;
  /** How much more than the baseline that is. */
  upliftUsdMinor: number | null;
  /** The month-over-month growth that gets there over the horizon. */
  impliedMonthlyGrowth: number | null;
  /** Set when the target cannot be reached at any revenue. */
  impossibleReason: string | null;
}

/**
 * Revenue required to hit a margin - Spec section 11, second mode.
 *
 * `revenue - expense = margin x revenue`, so `revenue = expense / (1 - margin)`.
 *
 * A margin of 1 or more is refused rather than returned as a huge number: at
 * 100% the equation divides by zero, and above it the arithmetic silently flips
 * sign and hands back a *negative* revenue target that would render as a
 * plausible-looking figure.
 */
export function requiredRevenueForMargin(
  targetMarginRatio: number,
  forecastExpenseUsdMinor: number,
  baselineRevenueUsdMinor: number,
  months: number,
): MarginTargetResult {
  if (targetMarginRatio >= 1) {
    return {
      requiredRevenueUsdMinor: null,
      upliftUsdMinor: null,
      impliedMonthlyGrowth: null,
      impossibleReason:
        'A margin of 100% or more would mean spending nothing at all. No revenue reaches it.',
    };
  }

  if (forecastExpenseUsdMinor <= 0) {
    return {
      requiredRevenueUsdMinor: null,
      upliftUsdMinor: null,
      impliedMonthlyGrowth: null,
      impossibleReason:
        'No forecast expense to measure a margin against. Record at least one complete month of spending first.',
    };
  }

  const required = Math.round(forecastExpenseUsdMinor / (1 - targetMarginRatio));

  // Growth from nothing is undefined, not infinite. Saying so beats printing a
  // percentage that means "any amount at all".
  const impliedMonthlyGrowth =
    baselineRevenueUsdMinor > 0 && months > 0
      ? Math.pow(required / baselineRevenueUsdMinor, 1 / months) - 1
      : null;

  return {
    requiredRevenueUsdMinor: required,
    upliftUsdMinor: required - baselineRevenueUsdMinor,
    impliedMonthlyGrowth,
    impossibleReason: null,
  };
}

// ─── Scenarios (spec 11) ────────────────────────────────────────────────────

export type ScenarioName = 'conservative' | 'base' | 'aggressive' | 'custom';

export interface Scenario {
  name: ScenarioName;
  label: string;
  revenueGrowthRate: number;
  /** Where the number came from, so nobody has to guess. */
  derivation: string;
}

/**
 * The three preset scenarios, derived from the company's own history.
 *
 * Section 11 asks for base, conservative and aggressive cases. Inventing
 * 5/10/20% would produce three numbers with no relationship to this business -
 * they would look authoritative and mean nothing. These come from what AHN has
 * actually done: the median month, and the quartiles either side of it.
 *
 * Quartiles rather than the weakest and strongest months. The extremes make
 * both outer cases hostage to one unusual month, which is the very thing the
 * base case uses a median to avoid.
 *
 * With fewer than three months of history there is no distribution to read, so
 * all three collapse to flat and say so. A single observed month is not a
 * conservative case.
 */
export function buildScenarios(baseline: Baseline): Scenario[] {
  const observed = baseline.observedGrowth;

  if (observed.length < 2) {
    return [
      {
        name: 'conservative',
        label: 'Conservative',
        revenueGrowthRate: 0,
        derivation: 'Flat — not enough history to read a range yet',
      },
      {
        name: 'base',
        label: 'Base',
        revenueGrowthRate: 0,
        derivation: `Flat — ${baseline.monthsSampled} complete month${baseline.monthsSampled === 1 ? '' : 's'} recorded`,
      },
      {
        name: 'aggressive',
        label: 'Aggressive',
        revenueGrowthRate: 0,
        derivation: 'Flat — needs at least three months to suggest an upside',
      },
    ];
  }

  const sorted = [...observed].sort((a, b) => a - b);
  const low = percentile(sorted, 0.25);
  const median = percentile(sorted, 0.5);
  const high = percentile(sorted, 0.75);
  const n = observed.length;

  return [
    {
      name: 'conservative',
      label: 'Conservative',
      // A floor above zero is not conservative — it assumes growth in the
      // pessimistic case.
      revenueGrowthRate: Math.min(low, 0),
      derivation:
        low < 0
          ? `Lower quartile of the last ${n} months (${formatRate(low)})`
          : `Flat — even the lower quartile of the last ${n} months grew`,
    },
    {
      name: 'base',
      label: 'Base',
      revenueGrowthRate: median,
      derivation: `Median of the last ${n} months (${formatRate(median)})`,
    },
    {
      name: 'aggressive',
      label: 'Aggressive',
      revenueGrowthRate: Math.max(high, 0),
      derivation: `Upper quartile of the last ${n} months (${formatRate(high)})`,
    },
  ];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function standardDeviation(values: number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Linear-interpolated percentile over an already-sorted array.
 *
 * Quartiles, not the minimum and maximum. The first version of this used the
 * weakest and strongest months, which made both outer scenarios hostage to a
 * single outlier — exactly the mistake the base case already avoided by using
 * the median. Against real data that produced a "conservative" case of -100%
 * (one month where revenue stopped) and an "aggressive" case of +1278% (one
 * month with a large contract), the second of which compounds over a year into
 * a number with no meaning at all.
 */
function percentile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 1) return sortedValues[0]!;
  const position = q * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower]!;
  return sortedValues[lower]! + (sortedValues[upper]! - sortedValues[lower]!) * (position - lower);
}

function formatRate(ratio: number): string {
  const pct = ratio * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`;
}

/**
 * Whether the preset scenarios describe a pattern or just a few odd months.
 *
 * Quartiles are robust to outliers *given enough points*. With three observed
 * growth rates the upper quartile still sits halfway to the maximum, so one
 * unusual month keeps most of its influence — against AHN's current data that
 * produced an "aggressive" case of +652% from a single large contract.
 *
 * More arithmetic cannot fix three data points. Saying so can. Two conditions,
 * either of which makes the presets indicative rather than meaningful:
 *
 *   - fewer than six months of observed growth, so the quartiles are being
 *     interpolated between a handful of points;
 *   - an interquartile range wider than 50 points, meaning the middle half of
 *     months disagree so much that no single rate represents them.
 */
export function scenarioReliability(baseline: Baseline): {
  reliable: boolean;
  reason: string | null;
} {
  const observed = baseline.observedGrowth;
  if (observed.length < 2) {
    return { reliable: false, reason: 'There is not enough history to read a range yet.' };
  }

  const sorted = [...observed].sort((a, b) => a - b);
  const iqr = percentile(sorted, 0.75) - percentile(sorted, 0.25);

  if (observed.length < MIN_MONTHS_FOR_SCENARIOS) {
    return {
      reliable: false,
      reason: `Only ${observed.length} months of growth to read. The quartiles are interpolated between a handful of points, so one unusual month still shapes the outer cases.`,
    };
  }

  if (iqr > MAX_IQR_FOR_SCENARIOS) {
    return {
      reliable: false,
      reason: `The middle half of months range across ${Math.round(iqr * 100)} points of growth. No single rate represents them.`,
    };
  }

  return { reliable: true, reason: null };
}

const MIN_MONTHS_FOR_SCENARIOS = 6;
const MAX_IQR_FOR_SCENARIOS = 0.5;
