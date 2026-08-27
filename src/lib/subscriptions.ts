/**
 * Recurring-charge detection — Spec section 8 (Subscription Intelligence).
 *
 * WHY THIS IS DERIVED, NOT READ OFF A FLAG
 *
 * `transactions.is_subscription` is set by the categoriser when it recognises a
 * vendor name from its rule list. That only ever finds vendors somebody already
 * wrote down. Spec section 8 asks which subscriptions exist and which have gone
 * up in price — questions a name list cannot answer, because the expensive
 * surprises are the tools nobody remembered signing up for.
 *
 * So this works from the payment pattern instead: the same payee, charged on a
 * regular cadence. That finds a $19.99 monthly charge from a vendor nobody has
 * ever heard of, which is exactly the one worth finding.
 *
 * Pure functions over plain rows, like the calc engine — no network, no
 * database. Spec section 20 keeps deterministic analysis separate from AI
 * interpretation, and this is deterministic analysis.
 */

import type { Transaction, TransactionWithContext } from '@/lib/types';
import { addDays, daysBetween, type ISODate } from '@/lib/dates';
import { countsTowardPnl, usdMinorOf, type UsdRateMap, IDENTITY_RATES } from '@/lib/calc/engine';

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'annual' | 'irregular';

export interface RecurringCharge {
  /** Stable key for the payee, so the same vendor merges across sources. */
  vendorKey: string;
  vendorName: string;
  cadence: Cadence;
  /** Median days between charges. */
  intervalDays: number;
  occurrences: number;
  firstSeen: ISODate;
  lastSeen: ISODate;
  /** Most recent amount, USD cents. */
  currentAmountUsdMinor: number;
  /** The amount before the most recent change, if the price ever moved. */
  previousAmountUsdMinor: number | null;
  /** Fractional change, e.g. 0.14 for a 14% rise. Null when the price is flat. */
  priceChange: number | null;
  priceChangedOn: ISODate | null;
  /** Current amount projected over a year at this cadence. */
  annualisedUsdMinor: number;
  /** Current amount expressed as a monthly figure, for comparing like with like. */
  monthlyEquivalentUsdMinor: number;
  /** last charge + interval. */
  nextExpected: ISODate;
  /** Days past `nextExpected`. Negative means it is not due yet. */
  daysOverdue: number;
  /** 0–1. How regular the intervals are; low means "probably coincidence". */
  confidence: number;
  /**
   * How tightly the charges sit on one or two price points, 0-1.
   *
   * This is what separates a subscription from a supplier you buy from often.
   * Both bill you on a regular rhythm; only the subscription bills the same
   * amount each time.
   */
  amountStability: number;
  /** Regularity of the gaps alone, before amount stability is folded in. */
  timingConfidence: number;
  category: string | null;
  transactionIds: string[];
}

const CADENCE_DAYS: Record<Exclude<Cadence, 'irregular'>, number> = {
  weekly: 7,
  monthly: 30,
  quarterly: 91,
  annual: 365,
};

/** Charges per year, used to annualise. */
const CADENCE_PER_YEAR: Record<Exclude<Cadence, 'irregular'>, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

/** Two amounts within this of each other are the same price point. */
const PRICE_POINT_TOLERANCE = 0.1;

/** Below this stability a "price change" is noise, not a new price. */
const PRICE_POINT_STABILITY = 0.7;

export interface DetectOptions {
  /** Fewest charges before a pattern is called recurring. */
  minOccurrences?: number;
  /** Below this, the pattern is treated as coincidence and dropped. */
  minConfidence?: number;
  /** Today, for overdue arithmetic. */
  asOf: ISODate;
  rates?: UsdRateMap;
}

/**
 * Find recurring charges in a transaction set.
 *
 * Only outflows that count toward P&L are considered: an internal transfer on a
 * monthly cadence is a funding run, not a subscription, and a duplicate would
 * invent a charge that never happened.
 */
export function detectRecurringCharges(
  transactions: Transaction[],
  options: DetectOptions,
): RecurringCharge[] {
  const minOccurrences = options.minOccurrences ?? 3;
  const minConfidence = options.minConfidence ?? 0.5;
  const rates = options.rates ?? IDENTITY_RATES;

  const groups = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.direction !== 'outflow' || !countsTowardPnl(t)) continue;
    const key = vendorKeyOf(t);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const found: RecurringCharge[] = [];

  for (const [vendorKey, rows] of groups) {
    if (rows.length < minOccurrences) continue;

    const sorted = [...rows].sort((a, b) => a.txn_date.localeCompare(b.txn_date));

    // Charges on the same day are one event split across lines (a fee booked
    // beside its charge, a split payment). Collapsing them first stops a
    // zero-day gap from destroying the interval maths.
    const byDay = new Map<ISODate, Transaction[]>();
    for (const t of sorted) {
      const list = byDay.get(t.txn_date);
      if (list) list.push(t);
      else byDay.set(t.txn_date, [t]);
    }
    const events = [...byDay.entries()].map(([date, sameDay]) => ({
      date,
      amountUsdMinor: sameDay.reduce((s, t) => s + usdMinorOf(t, rates), 0),
      ids: sameDay.map((t) => t.id),
    }));
    if (events.length < minOccurrences) continue;

    const intervals: number[] = [];
    for (let i = 1; i < events.length; i++) {
      intervals.push(daysBetween(events[i - 1]!.date, events[i]!.date));
    }
    if (intervals.length === 0) continue;

    const intervalDays = median(intervals);
    if (intervalDays <= 0) continue;

    const cadence = classifyCadence(intervalDays);
    const timingConfidence = scoreRegularity(intervals, intervalDays);

    const last = events[events.length - 1]!;
    const { previous, changedOn } = findPriceChange(events);

    // Regular timing alone is not enough. A hardware store you visit most weeks
    // has a rhythm too; what it does not have is a price. Scoring how tightly
    // the charges sit on their price points is what keeps ordinary suppliers
    // out of a list a CEO reads as "things we could cancel".
    const amountStability = scoreAmountStability(events.map((e) => e.amountUsdMinor));
    const confidence = timingConfidence * amountStability;
    if (confidence < minConfidence) continue;

    // With amounts this scattered the latest one is not a new price, it is just
    // the latest purchase. Reporting "price rose 391%" would be a false claim
    // about a vendor that never had a fixed price to raise.
    const priceIsReal = amountStability >= PRICE_POINT_STABILITY;

    const perYear =
      cadence === 'irregular' ? 365 / intervalDays : CADENCE_PER_YEAR[cadence];
    const annualised = Math.round(last.amountUsdMinor * perYear);
    const nextExpected = addDays(last.date, Math.round(intervalDays));

    found.push({
      vendorKey,
      vendorName: displayNameOf(rows),
      cadence,
      intervalDays: Math.round(intervalDays),
      occurrences: events.length,
      firstSeen: events[0]!.date,
      lastSeen: last.date,
      currentAmountUsdMinor: last.amountUsdMinor,
      previousAmountUsdMinor: priceIsReal ? previous : null,
      priceChange:
        priceIsReal && previous !== null && previous > 0
          ? (last.amountUsdMinor - previous) / previous
          : null,
      priceChangedOn: priceIsReal ? changedOn : null,
      annualisedUsdMinor: annualised,
      monthlyEquivalentUsdMinor: Math.round(annualised / 12),
      nextExpected,
      daysOverdue: daysBetween(nextExpected, options.asOf),
      confidence,
      amountStability,
      timingConfidence,
      category: rows[rows.length - 1]!.category,
      transactionIds: events.flatMap((e) => e.ids),
    });
  }

  return found.sort((a, b) => b.annualisedUsdMinor - a.annualisedUsdMinor);
}

// ─── Grouping ───────────────────────────────────────────────────────────────

/**
 * The key a vendor is grouped under.
 *
 * Prefers the counterparty id, which the ingest path has already normalised and
 * deduplicated across sources. Falls back to the description when a row has no
 * counterparty, stripping the digits that bank memos append to otherwise
 * identical charges ("Purchase 144", "INV-8823").
 */
function vendorKeyOf(t: Transaction): string | null {
  if (t.counterparty_id) return `cp:${t.counterparty_id}`;
  const raw = (t.description ?? '').trim();
  if (!raw) return null;
  const stripped = raw
    .toLowerCase()
    .replace(/[#*]/g, ' ')
    .replace(/\b(?:inv|ref|txn|no)?[-\s]?\d{2,}\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length >= 3 ? `desc:${stripped}` : null;
}

/**
 * What to call this vendor on screen.
 *
 * The counterparty name comes first, because it is what the ingest path
 * normalised and deduplicated. A QuickBooks description is often the fallback
 * the connector generated - "Purchase 143" - which names nothing. Showing that
 * on a cost-control page would list three charges from Hicks Hardware as three
 * unrelated mysteries.
 */
function displayNameOf(rows: Transaction[]): string {
  for (const r of rows as TransactionWithContext[]) {
    const name = r.counterparty?.name?.trim();
    if (name) return name;
  }
  // Bank memos with a trailing reference number say more without it.
  const described = rows.find((r) => r.description?.trim())?.description?.trim();
  if (!described) return 'Unknown vendor';
  return described.replace(/\s*\b\d{3,}\b\s*$/, '').trim() || described;
}

// ─── Cadence and regularity ─────────────────────────────────────────────────

export function classifyCadence(intervalDays: number): Cadence {
  for (const [name, days] of Object.entries(CADENCE_DAYS) as Array<
    [Exclude<Cadence, 'irregular'>, number]
  >) {
    // Monthly charges land anywhere from 28 to 31 days apart, and a weekend can
    // push one further, so each band is generous rather than exact.
    const tolerance = days <= 7 ? 2 : days <= 31 ? 6 : days * 0.2;
    if (Math.abs(intervalDays - days) <= tolerance) return name;
  }
  return 'irregular';
}

/**
 * How regular the gaps are, 0–1.
 *
 * Three coffees bought in a month are not a subscription. What separates a real
 * recurring charge is that the gaps are all about the same — so this scores the
 * spread of the intervals against their middle, and anything erratic falls
 * below the threshold and is dropped.
 */
export function scoreRegularity(intervals: number[], centre: number): number {
  if (intervals.length === 0 || centre <= 0) return 0;
  if (intervals.length === 1) {
    // A single gap says almost nothing. Give partial credit only when it lands
    // squarely on a recognised cadence.
    return classifyCadence(intervals[0]!) === 'irregular' ? 0.2 : 0.5;
  }
  const deviations = intervals.map((i) => Math.abs(i - centre) / centre);
  const meanDeviation = deviations.reduce((s, d) => s + d, 0) / deviations.length;
  return Math.max(0, Math.min(1, 1 - meanDeviation));
}

/**
 * How tightly the charges sit on repeated price points, 0-1.
 *
 * A subscription bills the same amount every period, and at most steps to a
 * new amount when the price changes - so its charges pile up on one or two
 * values. A vendor you simply buy from often has a rhythm but no price, and
 * its amounts land all over the place.
 *
 * The rule that does the work: a price point is a value that REPEATS. An
 * amount charged exactly once is not a price, it is a purchase - so a lone
 * amount earns nothing. Without that, anchoring on the two most recent amounts
 * handed every vendor two free perfect scores, and any short scattered series
 * cleared the bar on that alone.
 */
export function scoreAmountStability(amounts: number[]): number {
  if (amounts.length === 0) return 0;

  const sorted = [...amounts].filter((a) => a > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;

  const clusters: number[][] = [];
  for (const amount of sorted) {
    const open = clusters[clusters.length - 1];
    const base = open?.[0];
    if (open && base !== undefined && (amount - base) / base <= PRICE_POINT_TOLERANCE) {
      open.push(amount);
    } else {
      clusters.push([amount]);
    }
  }

  const pricePoints = clusters
    .filter((c) => c.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 2); // one price, plus the one it changed from

  const onAPrice = pricePoints.reduce((s, c) => s + c.length, 0);
  return onAPrice / amounts.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The amount charged before the most recent price change.
 *
 * Walks back from the latest charge to the first one that differs by more than
 * rounding. Small wobble is ignored: a currency-converted charge moves a cent
 * or two every month without the price having changed at all.
 */
function findPriceChange(
  events: Array<{ date: ISODate; amountUsdMinor: number }>,
): { previous: number | null; changedOn: ISODate | null } {
  const current = events[events.length - 1]!.amountUsdMinor;
  for (let i = events.length - 2; i >= 0; i--) {
    const earlier = events[i]!.amountUsdMinor;
    if (earlier === 0) continue;
    const drift = Math.abs(current - earlier) / earlier;
    if (drift > 0.005) {
      return { previous: earlier, changedOn: events[i + 1]!.date };
    }
  }
  return { previous: null, changedOn: null };
}

// ─── Portfolio summary (spec section 8 totals) ──────────────────────────────

export interface SubscriptionSummary {
  monthlyRecurringUsdMinor: number;
  annualisedUsdMinor: number;
  count: number;
  /** Charges whose price rose at the most recent change. */
  priceIncreases: RecurringCharge[];
  /** Due within the next 14 days. */
  upcomingRenewals: RecurringCharge[];
  /**
   * Overdue by more than one full interval — either cancelled without anyone
   * recording it, or a payment that failed and nobody noticed.
   */
  lapsed: RecurringCharge[];
  /** Vendors billing more than once on the same cadence: possible duplication. */
  possibleDuplicates: Array<{ category: string; charges: RecurringCharge[] }>;
  /**
   * A year of the charges that have stopped billing.
   *
   * Deliberately NOT called a saving. A lapsed charge is money already not
   * being spent, so there is nothing left to save - and it is as likely to be
   * a failed payment about to cost you the service as a cancellation nobody
   * wrote down. It is a number to go and check, not one to bank.
   */
  lapsedAnnualUsdMinor: number;
}

export function summariseSubscriptions(
  charges: RecurringCharge[],
  asOf: ISODate,
): SubscriptionSummary {
  const active = charges.filter((c) => c.daysOverdue <= c.intervalDays);

  const priceIncreases = charges
    .filter((c) => c.priceChange !== null && c.priceChange > 0.005)
    .sort((a, b) => (b.priceChange ?? 0) - (a.priceChange ?? 0));

  const upcomingRenewals = active
    .filter((c) => c.daysOverdue >= -14 && c.daysOverdue <= 0)
    .sort((a, b) => a.nextExpected.localeCompare(b.nextExpected));

  const lapsed = charges
    .filter((c) => c.daysOverdue > c.intervalDays)
    .sort((a, b) => b.annualisedUsdMinor - a.annualisedUsdMinor);

  // Two active charges in one category on the same cadence is the shape of
  // paying for the same thing twice. It is a prompt for a human, not a verdict.
  const byCategory = new Map<string, RecurringCharge[]>();
  for (const c of active) {
    const key = c.category ?? 'uncategorized';
    const list = byCategory.get(key);
    if (list) list.push(c);
    else byCategory.set(key, [c]);
  }
  const possibleDuplicates = [...byCategory]
    .filter(([category, list]) => category !== 'uncategorized' && list.length > 1)
    .map(([category, list]) => ({ category, charges: list }));

  return {
    monthlyRecurringUsdMinor: active.reduce((s, c) => s + c.monthlyEquivalentUsdMinor, 0),
    annualisedUsdMinor: active.reduce((s, c) => s + c.annualisedUsdMinor, 0),
    count: active.length,
    priceIncreases,
    upcomingRenewals,
    lapsed,
    possibleDuplicates,
    lapsedAnnualUsdMinor: lapsed.reduce((s, c) => s + c.annualisedUsdMinor, 0),
  };
}

export function cadenceLabel(cadence: Cadence): string {
  return { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual', irregular: 'Irregular' }[
    cadence
  ];
}
