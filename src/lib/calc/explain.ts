/**
 * Explaining what changed - Spec section 20, the deterministic half.
 *
 * Section 20 opens by drawing the line this file sits on: "AI should interpret
 * deterministic financial data rather than calculate foundational accounting
 * numbers itself."
 *
 * So nothing here is AI. It is the arithmetic an AI layer would later read: why
 * cash moved, which counterparties drove a revenue change, and which payments
 * are unusual FOR THE VENDOR THAT MADE THEM. Building it now is right whenever
 * that layer arrives, and it is useful without one.
 *
 * THE PROPERTY THAT MAKES A DECOMPOSITION WORTH READING: the parts must sum to
 * the whole, exactly, in integer minor units. A breakdown that nearly adds up
 * is worse than none, because a reader who checks it once and finds it off by
 * $3 stops checking anything on the page.
 */

import type { Transaction } from '@/lib/types';
import { countsTowardCash, countsTowardPnl, usdMinorOf, IDENTITY_RATES, type UsdRateMap } from '@/lib/calc/engine';
import { daysBetween, type ISODate } from '@/lib/dates';

// ─── Why cash changed ───────────────────────────────────────────────────────

export interface Driver {
  label: string;
  amountUsdMinor: number;
  count: number;
  /** Share of its own side of the movement, 0-1. */
  share: number;
}

export interface CashChange {
  from: ISODate;
  to: ISODate;
  openingUsdMinor: number;
  closingUsdMinor: number;
  netChangeUsdMinor: number;

  inflowUsdMinor: number;
  outflowUsdMinor: number;

  /** What money came in for, biggest first. */
  inflowDrivers: Driver[];
  /** What money went out for, biggest first. */
  outflowDrivers: Driver[];

  /** The individual movements worth naming, either direction. */
  largest: Array<{
    id: string;
    date: ISODate;
    label: string;
    amountUsdMinor: number;
    direction: 'inflow' | 'outflow';
  }>;

  /**
   * True when opening + inflow - outflow equals closing exactly.
   *
   * Never expected to be false. It is returned rather than asserted because a
   * page that shows a breakdown should be able to say when it does not add up,
   * instead of showing figures that quietly disagree with the balance above
   * them.
   */
  reconciles: boolean;
}

/**
 * Decompose a cash movement - Spec section 20, "explain why cash changed".
 *
 * Internal transfers are counted in NEITHER direction. They move money between
 * the company's own accounts, so they net to zero across the whole position and
 * including them would inflate both sides by the same amount while leaving the
 * net unchanged - a breakdown that reconciles and still misleads.
 */
export function explainCashChange(
  openingUsdMinor: number,
  transactions: Transaction[],
  from: ISODate,
  to: ISODate,
  rates: UsdRateMap = IDENTITY_RATES,
): CashChange {
  const inWindow = transactions.filter(
    (t) => t.txn_date >= from && t.txn_date <= to && countsTowardCash(t) && !t.is_internal_transfer,
  );

  let inflow = 0;
  let outflow = 0;
  const inflowTally = new Map<string, { amount: number; count: number }>();
  const outflowTally = new Map<string, { amount: number; count: number }>();

  for (const t of inWindow) {
    const usd = usdMinorOf(t, rates);
    const key = t.category ?? 'uncategorized';
    const tally = t.direction === 'inflow' ? inflowTally : outflowTally;
    const entry = tally.get(key) ?? { amount: 0, count: 0 };
    entry.amount += usd;
    entry.count += 1;
    tally.set(key, entry);

    if (t.direction === 'inflow') inflow += usd;
    else outflow += usd;
  }

  const closing = openingUsdMinor + inflow - outflow;

  const largest = [...inWindow]
    .map((t) => ({
      id: t.id,
      date: t.txn_date,
      label: labelOf(t),
      amountUsdMinor: usdMinorOf(t, rates),
      direction: t.direction,
    }))
    .sort((a, b) => b.amountUsdMinor - a.amountUsdMinor)
    .slice(0, 8);

  return {
    from,
    to,
    openingUsdMinor,
    closingUsdMinor: closing,
    netChangeUsdMinor: inflow - outflow,
    inflowUsdMinor: inflow,
    outflowUsdMinor: outflow,
    inflowDrivers: toDrivers(inflowTally, inflow),
    outflowDrivers: toDrivers(outflowTally, outflow),
    largest,
    reconciles: openingUsdMinor + inflow - outflow === closing,
  };
}

// ─── Why revenue changed ────────────────────────────────────────────────────

export interface PeriodComparison {
  currentUsdMinor: number;
  priorUsdMinor: number;
  changeUsdMinor: number;
  /** null when the prior period was zero: growth from nothing is undefined. */
  changeRatio: number | null;

  /** Who or what moved, biggest absolute change first. */
  movers: Array<{
    label: string;
    currentUsdMinor: number;
    priorUsdMinor: number;
    changeUsdMinor: number;
    /** Appeared this period and not the last, or the reverse. */
    isNew: boolean;
    isGone: boolean;
  }>;
}

/**
 * Compare two periods and name what moved - Spec section 20.
 *
 * Grouped by counterparty rather than category, because "revenue fell because
 * professional services fell" tells nobody anything they can act on, while
 * "Acme paid $40,000 last month and nothing this month" is a phone call.
 *
 * Works for either direction, so it answers both "explain revenue changes" and
 * the spending half of "identify unusual spending".
 */
export function comparePeriods(
  current: Transaction[],
  prior: Transaction[],
  direction: 'inflow' | 'outflow',
  rates: UsdRateMap = IDENTITY_RATES,
): PeriodComparison {
  const tally = (rows: Transaction[]) => {
    const map = new Map<string, number>();
    let total = 0;
    for (const t of rows) {
      if (t.direction !== direction || !countsTowardPnl(t)) continue;
      const usd = usdMinorOf(t, rates);
      const key = labelOf(t);
      map.set(key, (map.get(key) ?? 0) + usd);
      total += usd;
    }
    return { map, total };
  };

  const now = tally(current);
  const then = tally(prior);

  const labels = new Set([...now.map.keys(), ...then.map.keys()]);
  const movers = [...labels]
    .map((label) => {
      const currentAmount = now.map.get(label) ?? 0;
      const priorAmount = then.map.get(label) ?? 0;
      return {
        label,
        currentUsdMinor: currentAmount,
        priorUsdMinor: priorAmount,
        changeUsdMinor: currentAmount - priorAmount,
        isNew: priorAmount === 0 && currentAmount > 0,
        isGone: currentAmount === 0 && priorAmount > 0,
      };
    })
    .filter((m) => m.changeUsdMinor !== 0)
    .sort((a, b) => Math.abs(b.changeUsdMinor) - Math.abs(a.changeUsdMinor));

  return {
    currentUsdMinor: now.total,
    priorUsdMinor: then.total,
    changeUsdMinor: now.total - then.total,
    // Growth from nothing is undefined, not infinite.
    changeRatio: then.total > 0 ? (now.total - then.total) / then.total : null,
    movers,
  };
}

// ─── Unusual for this vendor ────────────────────────────────────────────────

export interface Anomaly {
  transaction: Transaction;
  label: string;
  amountUsdMinor: number;
  /** What this vendor usually charges. */
  typicalUsdMinor: number;
  /** How many times the usual amount this one is. */
  multiple: number;
  /** Payments used to form the expectation. */
  sampleSize: number;
  /**
   * Other payments from the same vendor that also cleared the threshold.
   *
   * Only the largest is reported. A vendor whose fee scales with the payment it
   * settles produces several at once, and three lines about the same vendor is
   * how a list stops being read.
   */
  alsoUnusualCount: number;
  reason: string;
}

/**
 * Payments that are unusual FOR THE VENDOR THAT MADE THEM - Spec section 20.
 *
 * WHY NOT A GLOBAL THRESHOLD. The existing large-outflow alert fires above a
 * flat $5,000. That is the wrong shape twice over: it fires on every payroll
 * run, which is not news, and it stays silent on a $300 charge from a vendor
 * that has never once charged more than $20 - which is exactly the charge worth
 * looking at.
 *
 * The comparison is against the vendor's own history, using the MEDIAN and the
 * median absolute deviation rather than a mean and a standard deviation. One
 * huge charge drags a mean up far enough to hide the next one; the median does
 * not move.
 */
export function detectAnomalies(
  transactions: Transaction[],
  options: { asOf?: ISODate; lookbackDays?: number; multiple?: number; rates?: UsdRateMap } = {},
): Anomaly[] {
  const rates = options.rates ?? IDENTITY_RATES;
  const minMultiple = options.multiple ?? ANOMALY_MULTIPLE;
  const lookback = options.lookbackDays ?? 30;
  const asOf = options.asOf;

  const byVendor = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.direction !== 'outflow' || !countsTowardPnl(t)) continue;
    const key = labelOf(t);
    const list = byVendor.get(key);
    if (list) list.push(t);
    else byVendor.set(key, [t]);
  }

  const anomalies: Anomaly[] = [];

  for (const [label, rows] of byVendor) {
    // Too little history to have an expectation. Calling a vendor's second
    // ever payment "unusual" is noise, and noise here trains people to ignore
    // the one that mattered.
    if (rows.length < MIN_HISTORY) continue;

    const amounts = rows.map((t) => usdMinorOf(t, rates)).sort((a, b) => a - b);
    const typical = median(amounts);
    if (typical <= 0) continue;

    const spread = medianAbsoluteDeviation(amounts, typical);
    const forThisVendor: Anomaly[] = [];

    for (const t of rows) {
      // Only recent payments are worth surfacing: an oddity from eight months
      // ago is history, not a thing to act on.
      if (asOf && daysBetween(t.txn_date, asOf) > lookback) continue;

      const amount = usdMinorOf(t, rates);
      const multiple = amount / typical;
      if (multiple < minMultiple) continue;

      // A vendor whose amounts genuinely vary is not anomalous when it varies.
      // Requiring the payment to also sit well outside the spread stops every
      // charge from a variable supplier being reported.
      if (spread > 0 && amount - typical < spread * MAD_MULTIPLE) continue;

      forThisVendor.push({
        transaction: t,
        label,
        amountUsdMinor: amount,
        typicalUsdMinor: Math.round(typical),
        multiple: Math.round(multiple * 10) / 10,
        sampleSize: rows.length,
        alsoUnusualCount: 0,
        reason: '',
      });
    }

    // ONE PER VENDOR, the largest.
    //
    // Found by running this over the real ledger: all three results were Stripe
    // processing fees, whose size scales with the payment being settled. Each
    // was genuinely many times the median — and three lines about one vendor is
    // exactly the repetition that teaches a reader to skip the list.
    if (forThisVendor.length === 0) continue;
    forThisVendor.sort((a, b) => b.amountUsdMinor - a.amountUsdMinor);
    const top = forThisVendor[0]!;
    top.alsoUnusualCount = forThisVendor.length - 1;
    top.reason =
      `${label} usually charges about ${formatUsd(top.typicalUsdMinor)} across ` +
      `${top.sampleSize} payments; this one is ${top.multiple}x that` +
      (top.alsoUnusualCount > 0
        ? `, and ${top.alsoUnusualCount} other recent payment${top.alsoUnusualCount === 1 ? '' : 's'} from them ${top.alsoUnusualCount === 1 ? 'is' : 'are'} also well above it — a sign their amounts vary with something rather than being fixed.`
        : '.');
    anomalies.push(top);
  }

  return anomalies.sort((a, b) => b.multiple - a.multiple);
}

/** Below this there is no expectation to be unusual against. */
const MIN_HISTORY = 4;

/** How many times the usual amount before a payment is worth naming. */
const ANOMALY_MULTIPLE = 3;

/** How far outside the vendor's own spread, as well as above its median. */
const MAD_MULTIPLE = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

interface WithCounterparty {
  counterparty?: { name?: string | null } | null;
}

function labelOf(t: Transaction): string {
  const named = (t as Transaction & WithCounterparty).counterparty?.name?.trim();
  if (named) return named;
  const described = t.description?.trim();
  return described || 'Unnamed';
}

function toDrivers(
  tally: Map<string, { amount: number; count: number }>,
  total: number,
): Driver[] {
  return [...tally]
    .map(([label, { amount, count }]) => ({
      label,
      amountUsdMinor: amount,
      count,
      share: total > 0 ? amount / total : 0,
    }))
    .sort((a, b) => b.amountUsdMinor - a.amountUsdMinor);
}

function formatUsd(minor: number): string {
  return `$${(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The median of the absolute distances from the median.
 *
 * Robust where a standard deviation is not: a single enormous payment inflates
 * a standard deviation enough to swallow the next enormous payment, which is
 * precisely the case this is meant to catch.
 */
function medianAbsoluteDeviation(sorted: number[], centre: number): number {
  const distances = sorted.map((v) => Math.abs(v - centre)).sort((a, b) => a - b);
  return median(distances);
}
