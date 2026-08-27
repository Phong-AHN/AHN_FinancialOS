import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { computeSnapshot, countsTowardPnl, usdMinorOf, type FinancialSnapshot, type UsdRateMap } from '@/lib/calc/engine';
import { loadUsdRates } from '@/lib/fx';
import { currentMonthRange, today } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import type { FinancialAccount, Transaction } from '@/lib/types';

/**
 * MVP Plan Day 6 deliverable: "Every dashboard number drills down to source
 * transactions."
 *
 * A tile that links to a filtered list is only useful if the list ADDS UP TO
 * THE TILE. A link that lands on a different number is worse than no link at
 * all - it teaches the reader that the figures cannot be trusted.
 *
 * Each test below replays exactly the filter its tile links to, and asserts the
 * filtered rows sum to what the tile displays.
 */
const CONFIGURED = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

describe.skipIf(!CONFIGURED)('dashboard tiles drill down to matching totals', () => {
  let snapshot: FinancialSnapshot;
  let transactions: Transaction[];
  let rates: UsdRateMap;
  const asOf = today();

  beforeAll(async () => {
    const db: SupabaseClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const [a, t] = await Promise.all([
      db.from('financial_accounts').select('*'),
      db.from('transactions').select('*').limit(20_000),
    ]);
    const accounts = (a.data ?? []) as FinancialAccount[];
    transactions = (t.data ?? []) as Transaction[];
    rates = await loadUsdRates(db, asOf);
    snapshot = computeSnapshot(accounts, transactions, asOf, rates);
  });

  /** Replays the /transactions filter the tile hrefs use. */
  function drill(opts: { direction?: 'inflow' | 'outflow'; from?: string; to?: string }) {
    return transactions
      .filter((t) => countsTowardPnl(t))
      .filter((t) => (opts.direction ? t.direction === opts.direction : true))
      .filter((t) => (opts.from ? t.txn_date >= opts.from : true))
      .filter((t) => (opts.to ? t.txn_date <= opts.to : true));
  }

  const sum = (rows: Transaction[]) => rows.reduce((s, t) => s + usdMinorOf(t, rates), 0);

  it('Revenue MTD tile matches its drill-down', () => {
    const month = currentMonthRange(asOf);
    const linked = sum(drill({ direction: 'inflow', from: month.from, to: asOf }));
    console.log(
      `  revenue MTD  tile ${formatMoney(snapshot.monthToDate.inflowUsdMinor)}` +
        `   link ${formatMoney(linked)}`,
    );
    expect(linked).toBe(snapshot.monthToDate.inflowUsdMinor);
  });

  it('Spent MTD tile matches its drill-down', () => {
    const month = currentMonthRange(asOf);
    const linked = sum(drill({ direction: 'outflow', from: month.from, to: asOf }));
    console.log(
      `  spent MTD    tile ${formatMoney(snapshot.monthToDate.outflowUsdMinor)}` +
        `   link ${formatMoney(linked)}`,
    );
    expect(linked).toBe(snapshot.monthToDate.outflowUsdMinor);
  });

  it('Net profit MTD tile matches its drill-down', () => {
    const month = currentMonthRange(asOf);
    const rows = drill({ from: month.from, to: asOf });
    const net =
      sum(rows.filter((t) => t.direction === 'inflow')) -
      sum(rows.filter((t) => t.direction === 'outflow'));
    console.log(
      `  net profit   tile ${formatMoney(snapshot.netProfitMtdUsdMinor)}   link ${formatMoney(net)}`,
    );
    expect(net).toBe(snapshot.netProfitMtdUsdMinor);
  });

  it('Monthly burn tile matches its drill-down', () => {
    const w = snapshot.burn.window;
    const linked = sum(drill({ direction: 'outflow', from: w.from, to: w.to }));
    // The tile shows the monthly AVERAGE over the window; the link shows the
    // window total. They must relate by exactly the months sampled.
    const expected = Math.round(linked / snapshot.burn.monthsSampled);
    console.log(
      `  monthly burn tile ${formatMoney(snapshot.burn.monthlyBurnUsdMinor)}` +
        `   link total ${formatMoney(linked)} over ${snapshot.burn.monthsSampled} months` +
        ` = ${formatMoney(expected)}`,
    );
    expect(expected).toBe(snapshot.burn.monthlyBurnUsdMinor);
  });

  it('Break-even tile links to the spend it is built from', () => {
    const month = currentMonthRange(asOf);
    const linked = sum(drill({ direction: 'outflow', from: month.from, to: asOf }));
    console.log(
      `  break-even   expense-to-date ${formatMoney(snapshot.breakEven.expenseToDateUsdMinor)}` +
        `   link ${formatMoney(linked)}`,
    );
    expect(linked).toBe(snapshot.breakEven.expenseToDateUsdMinor);
  });

  it('a future-dated transaction cannot split the tile from its drill-down', () => {
    // The regression the corrected links exist for. QuickBooks emits
    // future-dated rows routinely - a scheduled bill, a post-dated deposit - and
    // linking to month END would have swept them into the drill-down while the
    // month-to-date tile, computed through today, left them out.
    const month = currentMonthRange(asOf);
    const future: Transaction = {
      ...transactions.find((t) => t.direction === 'inflow' && countsTowardPnl(t))!,
      id: 'synthetic-future',
      txn_date: month.to,
      amount_minor: 999_999,
      amount_usd_minor: 999_999,
    };
    if (future.txn_date <= asOf) return; // month already over; nothing to prove

    const withFuture = [...transactions, future];
    const throughToday = withFuture
      .filter((t) => countsTowardPnl(t) && t.direction === 'inflow')
      .filter((t) => t.txn_date >= month.from && t.txn_date <= asOf);
    const throughMonthEnd = withFuture
      .filter((t) => countsTowardPnl(t) && t.direction === 'inflow')
      .filter((t) => t.txn_date >= month.from && t.txn_date <= month.to);

    // The two windows must differ - that is the trap. The tile and its link both
    // use the first, so they stay in agreement.
    expect(sum(throughMonthEnd)).toBeGreaterThan(sum(throughToday));
    expect(sum(throughToday)).toBe(snapshot.monthToDate.inflowUsdMinor);
  });
});
