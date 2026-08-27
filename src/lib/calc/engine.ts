/**
 * Deterministic calculation engine.
 *
 * Spec section 9: "Runway calculations should use deterministic math, not AI
 * estimation." Spec section 20: the AI layer INTERPRETS these numbers, it never
 * produces them. So everything here is a pure function over plain rows - no
 * network, no model, no hidden state - which is also what makes it unit
 * testable (see tests/calc.test.ts).
 *
 * Two filters run through the whole file, and mixing them up is the classic way
 * these dashboards go wrong:
 *
 *   countsTowardCash  - excludes suspected/confirmed duplicates, keeps internal
 *                       transfers (moving money between our own accounts really
 *                       does change each account balance).
 *   countsTowardPnl   - excludes duplicates AND internal transfers (moving your
 *                       own money is neither revenue nor expense).
 */

import type { FinancialAccount, Transaction, TxnDirection } from '@/lib/types';
import { convertMinor, DEFAULT_CURRENCY, sumMinor } from '@/lib/money';
import {
  addDays,
  currentMonthRange,
  dayOfMonth,
  daysInMonth,
  lastCompleteMonths,
  monthStart,
  monthsInRange,
  trailingDays,
  type DateRange,
  type ISODate,
} from '@/lib/dates';

/** Rates expressed as: 1 unit of the key currency = N USD. */
export type UsdRateMap = Record<string, number>;

export const IDENTITY_RATES: UsdRateMap = { USD: 1 };

// ─── Filters ────────────────────────────────────────────────────────────────

/** A duplicate must never inflate cash (Definition of Done, item 7). */
export function countsTowardCash(t: Pick<Transaction, 'reconciliation_status'>): boolean {
  return (
    t.reconciliation_status !== 'possible_duplicate' &&
    t.reconciliation_status !== 'duplicate_ignored'
  );
}

/** Operating money movement: excludes duplicates and own-account transfers. */
export function countsTowardPnl(
  t: Pick<Transaction, 'reconciliation_status' | 'is_internal_transfer'>,
): boolean {
  return countsTowardCash(t) && !t.is_internal_transfer;
}

// ─── Currency normalisation ─────────────────────────────────────────────────

/**
 * USD value of a transaction, in cents.
 *
 * Prefers the rate that was stamped on the row at ingest time (`amount_usd_minor`)
 * so a historical report does not silently change when today rate moves. Falls
 * back to the current rate map only when the row was never stamped.
 */
export function usdMinorOf(t: Transaction, rates: UsdRateMap = IDENTITY_RATES): number {
  if (typeof t.amount_usd_minor === 'number') return t.amount_usd_minor;
  const rate = rates[t.currency.toUpperCase()] ?? (t.currency.toUpperCase() === 'USD' ? 1 : 0);
  return convertMinor(t.amount_minor, t.currency, DEFAULT_CURRENCY, rate);
}

export function signedUsdMinorOf(t: Transaction, rates: UsdRateMap = IDENTITY_RATES): number {
  const magnitude = usdMinorOf(t, rates);
  return t.direction === 'inflow' ? magnitude : -magnitude;
}

// ─── Cash position ──────────────────────────────────────────────────────────

export interface AccountBalance {
  account: FinancialAccount;
  /** opening balance + sum of this account non-duplicate transactions. */
  derivedMinor: number;
  /** What the bank/provider last told us. Null for CSV-only accounts. */
  reportedMinor: number | null;
  /** The balance we present: reported when we have one, else derived. */
  balanceMinor: number;
  /** reported - derived. Non-zero means something is missing or double-booked. */
  varianceMinor: number | null;
  balanceUsdMinor: number;
  txnCount: number;
}

export interface CashPosition {
  totalUsdMinor: number;
  byAccount: AccountBalance[];
  byCompany: Array<{ companyId: string; totalUsdMinor: number }>;
  byCurrency: Array<{ currency: string; totalMinor: number; totalUsdMinor: number }>;
  /** Amount held out of cash because it is under duplicate review. */
  heldForReviewUsdMinor: number;
  /** Accounts whose reported and derived balances disagree. */
  unreconciledAccounts: number;
}

export function computeCashPosition(
  accounts: FinancialAccount[],
  transactions: Transaction[],
  rates: UsdRateMap = IDENTITY_RATES,
): CashPosition {
  const byAccountId = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const list = byAccountId.get(t.account_id);
    if (list) list.push(t);
    else byAccountId.set(t.account_id, [t]);
  }

  const balances: AccountBalance[] = accounts
    .filter((a) => a.is_active)
    .map((account) => {
      const txns = byAccountId.get(account.id) ?? [];
      const counted = txns.filter(countsTowardCash);
      const derivedMinor =
        account.opening_balance_minor +
        sumMinor(counted.map((t) => (t.direction === 'inflow' ? t.amount_minor : -t.amount_minor)));
      const reportedMinor = account.reported_balance_minor;
      const balanceMinor = reportedMinor ?? derivedMinor;
      const rate = rates[account.currency.toUpperCase()] ?? (account.currency === 'USD' ? 1 : 0);

      return {
        account,
        derivedMinor,
        reportedMinor,
        balanceMinor,
        varianceMinor: reportedMinor === null ? null : reportedMinor - derivedMinor,
        balanceUsdMinor: convertMinor(balanceMinor, account.currency, DEFAULT_CURRENCY, rate),
        txnCount: counted.length,
      };
    });

  const inCash = balances.filter((b) => b.account.include_in_cash);

  const byCompanyMap = new Map<string, number>();
  for (const b of inCash) {
    byCompanyMap.set(
      b.account.company_id,
      (byCompanyMap.get(b.account.company_id) ?? 0) + b.balanceUsdMinor,
    );
  }

  const byCurrencyMap = new Map<string, { totalMinor: number; totalUsdMinor: number }>();
  for (const b of inCash) {
    const key = b.account.currency.toUpperCase();
    const entry = byCurrencyMap.get(key) ?? { totalMinor: 0, totalUsdMinor: 0 };
    entry.totalMinor += b.balanceMinor;
    entry.totalUsdMinor += b.balanceUsdMinor;
    byCurrencyMap.set(key, entry);
  }

  const heldForReviewUsdMinor = sumMinor(
    transactions
      .filter((t) => !countsTowardCash(t))
      .map((t) => Math.abs(signedUsdMinorOf(t, rates))),
  );

  return {
    totalUsdMinor: sumMinor(inCash.map((b) => b.balanceUsdMinor)),
    byAccount: balances.sort((a, b) => b.balanceUsdMinor - a.balanceUsdMinor),
    byCompany: [...byCompanyMap].map(([companyId, totalUsdMinor]) => ({ companyId, totalUsdMinor })),
    byCurrency: [...byCurrencyMap].map(([currency, v]) => ({ currency, ...v })),
    heldForReviewUsdMinor,
    unreconciledAccounts: balances.filter((b) => b.varianceMinor !== null && b.varianceMinor !== 0)
      .length,
  };
}

// ─── Period flows ───────────────────────────────────────────────────────────

export function inRange(date: ISODate, range: DateRange): boolean {
  return date >= range.from && date <= range.to;
}

function flowInRange(
  transactions: Transaction[],
  range: DateRange,
  direction: TxnDirection,
  rates: UsdRateMap,
): number {
  return sumMinor(
    transactions
      .filter(
        (t) => countsTowardPnl(t) && t.direction === direction && inRange(t.txn_date, range),
      )
      .map((t) => usdMinorOf(t, rates)),
  );
}

export interface PeriodFlow {
  range: DateRange;
  inflowUsdMinor: number;
  outflowUsdMinor: number;
  netUsdMinor: number;
  txnCount: number;
}

export function computeFlow(
  transactions: Transaction[],
  range: DateRange,
  rates: UsdRateMap = IDENTITY_RATES,
): PeriodFlow {
  const inflow = flowInRange(transactions, range, 'inflow', rates);
  const outflow = flowInRange(transactions, range, 'outflow', rates);
  return {
    range,
    inflowUsdMinor: inflow,
    outflowUsdMinor: outflow,
    netUsdMinor: inflow - outflow,
    txnCount: transactions.filter((t) => countsTowardPnl(t) && inRange(t.txn_date, range)).length,
  };
}

// ─── Burn rate ──────────────────────────────────────────────────────────────

export interface BurnRate {
  /** Average monthly operating outflow, USD cents. */
  monthlyBurnUsdMinor: number;
  /** Average monthly net burn (outflow - inflow); 0 when the company is net positive. */
  netMonthlyBurnUsdMinor: number;
  monthsSampled: number;
  /** The single worst month of operating outflow in the window. */
  worstMonthOutflowUsdMinor: number;
  worstMonth: ISODate | null;
  window: DateRange;
  perMonth: Array<{ month: ISODate; outflowUsdMinor: number; inflowUsdMinor: number }>;
  /** False when there is not a single complete month of data yet. */
  hasEnoughData: boolean;
}

/**
 * Burn = average operating outflow over the last N COMPLETE calendar months.
 *
 * The current month is excluded on purpose: on the 3rd of the month it holds
 * three days of spend, and averaging that in would understate burn and flatter
 * runway. MVP Plan Day 5 specifies a 3-month window.
 */
export function computeBurnRate(
  transactions: Transaction[],
  asOf: ISODate,
  monthsBack = 3,
  rates: UsdRateMap = IDENTITY_RATES,
): BurnRate {
  const window = lastCompleteMonths(asOf, monthsBack);
  const monthsSampled = Math.max(1, monthsInRange(window));

  const perMonthMap = new Map<ISODate, { outflowUsdMinor: number; inflowUsdMinor: number }>();
  for (const t of transactions) {
    if (!countsTowardPnl(t) || !inRange(t.txn_date, window)) continue;
    const key = monthStart(t.txn_date);
    const entry = perMonthMap.get(key) ?? { outflowUsdMinor: 0, inflowUsdMinor: 0 };
    if (t.direction === 'outflow') entry.outflowUsdMinor += usdMinorOf(t, rates);
    else entry.inflowUsdMinor += usdMinorOf(t, rates);
    perMonthMap.set(key, entry);
  }

  const totalOutflow = sumMinor([...perMonthMap.values()].map((v) => v.outflowUsdMinor));
  const totalInflow = sumMinor([...perMonthMap.values()].map((v) => v.inflowUsdMinor));

  const monthlyBurnUsdMinor = Math.round(totalOutflow / monthsSampled);
  const netBurn = Math.round((totalOutflow - totalInflow) / monthsSampled);

  let worstMonthOutflowUsdMinor = 0;
  let worstMonth: ISODate | null = null;
  for (const [month, v] of perMonthMap) {
    if (v.outflowUsdMinor > worstMonthOutflowUsdMinor) {
      worstMonthOutflowUsdMinor = v.outflowUsdMinor;
      worstMonth = month;
    }
  }

  return {
    monthlyBurnUsdMinor,
    netMonthlyBurnUsdMinor: Math.max(0, netBurn),
    monthsSampled,
    worstMonthOutflowUsdMinor,
    worstMonth,
    window,
    perMonth: [...perMonthMap]
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    hasEnoughData: perMonthMap.size > 0,
  };
}

// ─── Runway ─────────────────────────────────────────────────────────────────

export interface Runway {
  /** Cash / gross monthly burn - how long the cash lasts if revenue stopped. */
  grossMonths: number | null;
  /** Cash / NET monthly burn. Null when the company is cash-positive. */
  netMonths: number | null;
  /** Cash / the worst single month of outflow observed (spec 9 downside case). */
  worstCaseMonths: number | null;
  /**
   * True when revenue covered spend across the whole window, i.e. net burn is
   * zero. This is the case that has to be reported carefully - see below.
   */
  cashPositive: boolean;
  /**
   * The figure to put in front of a CEO.
   *
   * When the company is burning, that is net runway. When it is cash-positive,
   * net runway is mathematically infinite - and printing an infinity symbol to
   * someone who spends USD 90k a month is the most flattering possible way to
   * be wrong. The honest answer is the GROSS figure: how long the cash lasts if
   * revenue stopped. A company one lost client from trouble should not read its
   * dashboard as untroubled.
   */
  headlineMonths: number | null;
  cashUsdMinor: number;
  monthlyBurnUsdMinor: number;
  netMonthlyBurnUsdMinor: number;
  worstMonthOutflowUsdMinor: number;
}

export function computeRunway(cashUsdMinor: number, burn: BurnRate): Runway {
  const div = (cash: number, perMonth: number): number | null =>
    perMonth <= 0 ? null : Math.max(0, cash / perMonth);

  const grossMonths = div(cashUsdMinor, burn.monthlyBurnUsdMinor);
  const netMonths = div(cashUsdMinor, burn.netMonthlyBurnUsdMinor);
  const cashPositive = burn.netMonthlyBurnUsdMinor <= 0 && burn.monthlyBurnUsdMinor > 0;

  return {
    grossMonths,
    netMonths,
    worstCaseMonths: div(cashUsdMinor, burn.worstMonthOutflowUsdMinor),
    cashPositive,
    headlineMonths: cashPositive ? grossMonths : netMonths,
    cashUsdMinor,
    monthlyBurnUsdMinor: burn.monthlyBurnUsdMinor,
    netMonthlyBurnUsdMinor: burn.netMonthlyBurnUsdMinor,
    worstMonthOutflowUsdMinor: burn.worstMonthOutflowUsdMinor,
  };
}

// ─── Break-even revenue ─────────────────────────────────────────────────────

export interface BreakEven {
  month: DateRange;
  /** Revenue needed this month to cover expected total cost. */
  requiredRevenueUsdMinor: number;
  expenseToDateUsdMinor: number;
  projectedRemainingExpenseUsdMinor: number;
  revenueReceivedUsdMinor: number;
  /** How much more revenue is still needed. 0 once break-even is passed. */
  gapUsdMinor: number;
  /** Revenue above break-even. 0 while still short. */
  surplusUsdMinor: number;
  daysElapsed: number;
  daysRemaining: number;
  avgDailyOutflowUsdMinor: number;
}

/**
 * Break-even revenue for the month containing `asOf`.
 *
 *   required = expense booked so far this month
 *            + (trailing-90-day average daily operating outflow x days left)
 *
 * MVP Plan Day 5 defines it as "total expected expense for the current month".
 * Projecting the remainder from a trailing daily average keeps it deterministic
 * and self-correcting: as the month fills in with real spend, the projected
 * portion shrinks and the number converges on actuals.
 */
export function computeBreakEven(
  transactions: Transaction[],
  asOf: ISODate,
  rates: UsdRateMap = IDENTITY_RATES,
): BreakEven {
  const month = currentMonthRange(asOf);
  const mtd = { from: month.from, to: asOf };

  const expenseToDate = flowInRange(transactions, mtd, 'outflow', rates);
  const revenueReceived = flowInRange(transactions, mtd, 'inflow', rates);

  const lookback = trailingDays(asOf, 90);
  const lookbackOutflow = flowInRange(transactions, lookback, 'outflow', rates);
  const avgDailyOutflowUsdMinor = Math.round(lookbackOutflow / 90);

  const daysElapsed = dayOfMonth(asOf);
  const daysRemaining = daysInMonth(asOf) - daysElapsed;
  const projectedRemaining = avgDailyOutflowUsdMinor * daysRemaining;

  const required = expenseToDate + projectedRemaining;

  return {
    month,
    requiredRevenueUsdMinor: required,
    expenseToDateUsdMinor: expenseToDate,
    projectedRemainingExpenseUsdMinor: projectedRemaining,
    revenueReceivedUsdMinor: revenueReceived,
    gapUsdMinor: Math.max(0, required - revenueReceived),
    surplusUsdMinor: Math.max(0, revenueReceived - required),
    daysElapsed,
    daysRemaining,
    avgDailyOutflowUsdMinor,
  };
}

// ─── Assembled dashboard state ──────────────────────────────────────────────

export interface FinancialSnapshot {
  asOf: ISODate;
  cash: CashPosition;
  monthToDate: PeriodFlow;
  previousMonth: PeriodFlow;
  burn: BurnRate;
  runway: Runway;
  breakEven: BreakEven;
  netProfitMtdUsdMinor: number;
  /** Month-over-month revenue change; null when last month had no revenue. */
  revenueMoMChange: number | null;
}

export function computeSnapshot(
  accounts: FinancialAccount[],
  transactions: Transaction[],
  asOf: ISODate,
  rates: UsdRateMap = IDENTITY_RATES,
): FinancialSnapshot {
  const cash = computeCashPosition(accounts, transactions, rates);
  const month = currentMonthRange(asOf);
  const monthToDate = computeFlow(transactions, { from: month.from, to: asOf }, rates);
  const prev = lastCompleteMonths(asOf, 1);
  const previousMonth = computeFlow(transactions, prev, rates);
  const burn = computeBurnRate(transactions, asOf, 3, rates);
  const runway = computeRunway(cash.totalUsdMinor, burn);
  const breakEven = computeBreakEven(transactions, asOf, rates);

  const revenueMoMChange =
    previousMonth.inflowUsdMinor > 0
      ? (monthToDate.inflowUsdMinor - previousMonth.inflowUsdMinor) / previousMonth.inflowUsdMinor
      : null;

  return {
    asOf,
    cash,
    monthToDate,
    previousMonth,
    burn,
    runway,
    breakEven,
    netProfitMtdUsdMinor: monthToDate.netUsdMinor,
    revenueMoMChange,
  };
}

// ─── Daily cash trend (for the home-screen sparkline) ───────────────────────

export interface CashPoint {
  date: ISODate;
  cashUsdMinor: number;
}

/**
 * Walks today cash backwards through the transaction history to reconstruct a
 * daily balance series. Anchoring on the present rather than on the opening
 * balance means the last point always equals the number in the headline tile.
 */
export function computeCashTrend(
  currentCashUsdMinor: number,
  transactions: Transaction[],
  accounts: FinancialAccount[],
  asOf: ISODate,
  days = 30,
  rates: UsdRateMap = IDENTITY_RATES,
): CashPoint[] {
  // Only movements on accounts that are PART of cash may move the cash line.
  // Without this filter a credit-card charge shifts the history of a figure it
  // was never included in, and the chart shows a past that did not happen -
  // while the final point, anchored on today's real cash, still looks right.
  const cashAccountIds = new Set(
    accounts.filter((a) => a.is_active && a.include_in_cash).map((a) => a.id),
  );

  const deltaByDay = new Map<ISODate, number>();
  for (const t of transactions) {
    if (!countsTowardCash(t)) continue;
    if (!cashAccountIds.has(t.account_id)) continue;
    deltaByDay.set(t.txn_date, (deltaByDay.get(t.txn_date) ?? 0) + signedUsdMinorOf(t, rates));
  }

  const points: CashPoint[] = [{ date: asOf, cashUsdMinor: currentCashUsdMinor }];
  let running = currentCashUsdMinor;
  for (let i = 0; i < days - 1; i++) {
    const day = addDays(asOf, -i);
    running -= deltaByDay.get(day) ?? 0;
    points.push({ date: addDays(day, -1), cashUsdMinor: running });
  }
  return points.reverse();
}
