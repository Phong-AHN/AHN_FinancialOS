/**
 * Receivables and payables - Spec sections 17 and 18.
 *
 * Pure functions over obligations: money that is going to move but has not.
 *
 * THE DISTINCTION THAT MAKES THIS WORTH HAVING. A transaction is money that
 * moved. An obligation is money that is going to. Section 18 exists because a
 * company with $200k in the bank and $180k of payroll due on Friday does not
 * have $200k, and every cash figure in this system says it does.
 *
 * THE DOUBLE-COUNT THIS FILE HAS TO PREVENT. Once an obligation is paid, the
 * payment is in the ledger AND the obligation is still on the books unless
 * somebody marks it settled. Subtracting it again from projected cash would
 * charge the company twice for one bill. Nothing in the database prevents that,
 * so `findLikelySettled` looks for the transaction that already paid an open
 * obligation and the page says so.
 */

import type { Transaction, TxnDirection, SourceSystem } from '@/lib/types';
import { countsTowardCash, usdMinorOf, IDENTITY_RATES, type UsdRateMap } from '@/lib/calc/engine';
import { addDays, daysBetween, type ISODate } from '@/lib/dates';

export type ObligationStatus = 'draft' | 'open' | 'settled' | 'void';

export interface Obligation {
  id: string;
  direction: TxnDirection;
  counterparty_id: string | null;
  counterparty_name: string | null;
  project_id: string | null;
  category: string | null;
  reference: string | null;
  description: string | null;
  amount_minor: number;
  currency: string;
  contracted_amount_minor: number | null;
  issued_on: ISODate | null;
  due_on: ISODate;
  status: ObligationStatus;
  settled_txn_id: string | null;
  settled_on: ISODate | null;
  is_recurring: boolean;

  /**
   * Where the row came from - migration 0027.
   *
   * Optional here because the aging arithmetic does not care, and every test
   * fixture in this file predates the column. The alert engine does care: a
   * QuickBooks *sandbox* invoice must not page anybody, and without this field
   * it could not tell one from a commitment somebody typed.
   */
  source_system?: SourceSystem | null;
}

// ─── Aging (spec 17) ────────────────────────────────────────────────────────

/**
 * The standard buckets, by how far PAST DUE something is.
 *
 * `not_due` is separate from `current` on purpose. An invoice due next week and
 * one that fell due yesterday are in completely different states, and a single
 * "current" bucket hides which is which.
 */
export type AgingBucket = 'not_due' | 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export const AGING_ORDER: readonly AgingBucket[] = [
  'not_due',
  'current',
  'd1_30',
  'd31_60',
  'd61_90',
  'd90_plus',
] as const;

export const AGING_LABELS: Record<AgingBucket, string> = {
  not_due: 'Not yet due',
  current: 'Due today',
  d1_30: '1–30 days over',
  d31_60: '31–60 days over',
  d61_90: '61–90 days over',
  d90_plus: 'Over 90 days',
};

export function agingBucket(dueOn: ISODate, asOf: ISODate): AgingBucket {
  const daysOverdue = daysBetween(dueOn, asOf);
  if (daysOverdue < 0) return 'not_due';
  if (daysOverdue === 0) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90_plus';
}

export interface AgingLine {
  bucket: AgingBucket;
  label: string;
  amountUsdMinor: number;
  count: number;
}

/**
 * Aging over the obligations that are still outstanding.
 *
 * Settled and void rows are excluded: aging is about what is still owed, and a
 * paid invoice sitting in a 90-day bucket makes a collections problem look
 * worse than it is.
 */
export function agingReport(
  obligations: Obligation[],
  asOf: ISODate,
  rates: UsdRateMap = IDENTITY_RATES,
): AgingLine[] {
  const tally = new Map<AgingBucket, { amount: number; count: number }>();

  for (const o of obligations) {
    if (!isOutstanding(o)) continue;
    const bucket = agingBucket(o.due_on, asOf);
    const entry = tally.get(bucket) ?? { amount: 0, count: 0 };
    entry.amount += toUsdMinor(o, rates);
    entry.count += 1;
    tally.set(bucket, entry);
  }

  return AGING_ORDER.map((bucket) => ({
    bucket,
    label: AGING_LABELS[bucket],
    amountUsdMinor: tally.get(bucket)?.amount ?? 0,
    count: tally.get(bucket)?.count ?? 0,
  }));
}

/** Draft counts: it is money expected, just not yet issued. */
export function isOutstanding(o: Obligation): boolean {
  return o.status === 'open' || o.status === 'draft';
}

// ─── Ledger summary (spec 17: contracted, invoiced, due, paid, overdue) ─────

export interface LedgerSummary {
  /** What was agreed, where anyone recorded it. */
  contractedUsdMinor: number;
  /** What has actually been issued as an invoice or a commitment. */
  invoicedUsdMinor: number;
  /** Outstanding and not yet past its due date. */
  dueUsdMinor: number;
  /** Outstanding and past due. */
  overdueUsdMinor: number;
  paidUsdMinor: number;
  count: number;
  overdueCount: number;
  /** The single oldest unpaid item, which is usually the one to chase. */
  oldestOverdueDays: number | null;
}

export function summarise(
  obligations: Obligation[],
  asOf: ISODate,
  rates: UsdRateMap = IDENTITY_RATES,
): LedgerSummary {
  let contracted = 0;
  let invoiced = 0;
  let due = 0;
  let overdue = 0;
  let paid = 0;
  let overdueCount = 0;
  let oldest: number | null = null;

  for (const o of obligations) {
    if (o.status === 'void') continue;
    const usd = toUsdMinor(o, rates);

    // Falls back to the amount itself: a commitment with no separate contract
    // figure was still contracted for what it says.
    contracted += o.contracted_amount_minor ?? usd;

    if (o.status === 'settled') {
      paid += usd;
      continue;
    }

    invoiced += usd;
    const daysOverdue = daysBetween(o.due_on, asOf);
    if (daysOverdue > 0) {
      overdue += usd;
      overdueCount += 1;
      oldest = oldest === null ? daysOverdue : Math.max(oldest, daysOverdue);
    } else {
      due += usd;
    }
  }

  return {
    contractedUsdMinor: contracted,
    invoicedUsdMinor: invoiced,
    dueUsdMinor: due,
    overdueUsdMinor: overdue,
    paidUsdMinor: paid,
    count: obligations.filter((o) => o.status !== 'void').length,
    overdueCount,
    oldestOverdueDays: oldest,
  };
}

// ─── Projected cash (spec 18) ───────────────────────────────────────────────

export interface CashProjection {
  cashTodayUsdMinor: number;
  horizonDays: number;
  through: ISODate;

  /** Payables and commitments falling due inside the horizon. */
  obligationsDueUsdMinor: number;
  /** Receivables expected inside the horizon. */
  receivablesDueUsdMinor: number;

  /**
   * Cash today minus what is owed. The figure to plan against.
   *
   * Receivables are deliberately excluded. Money owed to a company is not
   * money it has: an invoice can be paid late, disputed, or not at all, while
   * payroll on Friday happens on Friday. Counting expected receipts in the
   * figure a person plans against is how a company runs out of cash while its
   * dashboard says it is fine.
   */
  committedCashUsdMinor: number;

  /** The optimistic view, offered separately and labelled as such. */
  withReceivablesUsdMinor: number;

  /** True when meeting the obligations would leave less than nothing. */
  shortfall: boolean;
  /** The day the running balance first goes negative, if it does. */
  shortfallDate: ISODate | null;

  /** Every dated step, so a page can draw the fall rather than assert it. */
  timeline: Array<{
    date: ISODate;
    obligationUsdMinor: number;
    runningCommittedUsdMinor: number;
    label: string;
  }>;
}

/**
 * What cash looks like once the known obligations are met - Spec section 18.
 *
 * The headline is committed cash: today's balance minus everything owed inside
 * the horizon, with receivables left out. That asymmetry is the point of the
 * whole calculation. A bill is a promise the company has to keep; an invoice is
 * a promise somebody else made to it.
 */
export function projectCash(
  cashTodayUsdMinor: number,
  obligations: Obligation[],
  asOf: ISODate,
  horizonDays = 30,
  rates: UsdRateMap = IDENTITY_RATES,
): CashProjection {
  const through = addDays(asOf, horizonDays);

  const inHorizon = obligations
    .filter((o) => isOutstanding(o) && o.due_on <= through)
    .sort((a, b) => a.due_on.localeCompare(b.due_on));

  let payables = 0;
  let receivables = 0;
  let running = cashTodayUsdMinor;
  let shortfallDate: ISODate | null = null;
  const timeline: CashProjection['timeline'] = [];

  for (const o of inHorizon) {
    const usd = toUsdMinor(o, rates);

    if (o.direction === 'outflow') {
      payables += usd;
      running -= usd;
      if (shortfallDate === null && running < 0) shortfallDate = o.due_on;
      timeline.push({
        // Something already overdue is due now, not in the past: it still has
        // to be paid, and dating it backwards would drop it off the chart.
        date: o.due_on < asOf ? asOf : o.due_on,
        obligationUsdMinor: usd,
        runningCommittedUsdMinor: running,
        label: o.description ?? o.counterparty_name ?? 'Obligation',
      });
    } else {
      receivables += usd;
    }
  }

  const committed = cashTodayUsdMinor - payables;

  return {
    cashTodayUsdMinor,
    horizonDays,
    through,
    obligationsDueUsdMinor: payables,
    receivablesDueUsdMinor: receivables,
    committedCashUsdMinor: committed,
    withReceivablesUsdMinor: committed + receivables,
    shortfall: committed < 0,
    shortfallDate,
    timeline,
  };
}

// ─── The double count ───────────────────────────────────────────────────────

export interface LikelySettlement {
  obligation: Obligation;
  transaction: Transaction;
  daysApart: number;
}

/**
 * Open obligations that a real transaction appears to have already paid.
 *
 * Once a bill is paid the payment is in the ledger, and the obligation stays on
 * the books until somebody marks it settled. Until they do, projected cash
 * subtracts it a second time — so a company that has already paid its rent is
 * told it still has to.
 *
 * Deliberately a SUGGESTION, never automatic. Matching on amount and date is
 * the same heuristic the duplicate detector uses, and it is wrong often enough
 * that settling an invoice on its say-so would eventually close the wrong one.
 * A person confirms; this only finds candidates.
 */
export function findLikelySettled(
  obligations: Obligation[],
  transactions: Transaction[],
  options: { windowDays?: number; rates?: UsdRateMap } = {},
): LikelySettlement[] {
  const windowDays = options.windowDays ?? 7;
  const rates = options.rates ?? IDENTITY_RATES;
  const matches: LikelySettlement[] = [];
  const claimed = new Set<string>();

  for (const o of obligations) {
    if (!isOutstanding(o)) continue;
    const target = toUsdMinor(o, rates);

    for (const t of transactions) {
      if (claimed.has(t.id)) continue;
      // A duplicate is not a payment, and a transfer is not a settlement.
      if (!countsTowardCash(t) || t.is_internal_transfer) continue;
      if (t.direction !== o.direction) continue;
      if (usdMinorOf(t, rates) !== target) continue;

      const apart = Math.abs(daysBetween(o.due_on, t.txn_date));
      if (apart > windowDays) continue;

      claimed.add(t.id);
      matches.push({ obligation: o, transaction: t, daysApart: apart });
      break;
    }
  }

  return matches.sort((a, b) => a.daysApart - b.daysApart);
}

function toUsdMinor(o: Obligation, rates: UsdRateMap): number {
  const code = o.currency.toUpperCase();
  if (code === 'USD') return o.amount_minor;
  const rate = rates[code];
  // A currency with no rate contributes zero rather than being treated 1:1.
  // Understating what is owed is recoverable; a 25,000x overstatement of a dong
  // commitment is not. The accounts page surfaces the missing rate.
  if (rate === undefined) return 0;
  return Math.round(o.amount_minor * rate * 100);
}
