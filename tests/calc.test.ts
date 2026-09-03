import { describe, expect, it } from 'vitest';
import {
  computeBreakEven,
  computeBurnRate,
  computeCashPosition,
  computeCashTrend,
  computeRunway,
  computeSnapshot,
} from '@/lib/calc/engine';
import type { FinancialAccount, Transaction } from '@/lib/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const RATES = { USD: 1, VND: 0.00004 };

function account(overrides: Partial<FinancialAccount> = {}): FinancialAccount {
  return {
    id: 'acc-us',
    company_id: 'co-1',
    name: 'US Operating',
    type: 'checking',
    currency: 'USD',
    source_system: 'plaid',
    external_account_id: 'ext-1',
    mask: null,
    opening_balance_minor: 0,
    reported_balance_minor: null,
    reported_balance_at: null,
    include_in_cash: true,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

let counter = 0;
function txn(overrides: Partial<Transaction> = {}): Transaction {
  const amount = overrides.amount_minor ?? 10_000;
  const direction = overrides.direction ?? 'outflow';
  return {
    id: `txn-${++counter}`,
    account_id: 'acc-us',
    counterparty_id: null,
    txn_date: '2026-08-10',
    posted_at: null,
    amount_minor: amount,
    currency: 'USD',
    direction,
    amount_usd_minor: amount,
    fx_rate: 1,
    description: null,
    category: null,
    subcategory: null,
    is_internal_transfer: false,
    project_id: null,
    is_recurring: false,
    is_subscription: false,
    source_system: 'plaid',
    external_txn_id: `ext-${counter}`,
    reconciliation_status: 'unreconciled',
    duplicate_of_id: null,
    manual_import_id: null,
    notes: null,
    raw: null,
    alerted_at: null,
    created_at: '2026-08-10T00:00:00Z',
    updated_at: '2026-08-10T00:00:00Z',
    signed_minor: direction === 'inflow' ? amount : -amount,
    signed_usd_minor: direction === 'inflow' ? amount : -amount,
    ...overrides,
  };
}

// ─── Cash ───────────────────────────────────────────────────────────────────

describe('computeCashPosition', () => {
  it('derives a balance from the opening balance plus signed transactions', () => {
    const accounts = [account({ opening_balance_minor: 100_000 })];
    const txns = [
      txn({ direction: 'inflow', amount_minor: 50_000 }),
      txn({ direction: 'outflow', amount_minor: 20_000 }),
    ];

    const cash = computeCashPosition(accounts, txns, RATES);
    expect(cash.byAccount[0]!.derivedMinor).toBe(130_000);
    expect(cash.totalUsdMinor).toBe(130_000);
  });

  it('EXCLUDES suspected duplicates from cash', () => {
    // The non-negotiable one: the same payment from the bank feed and from
    // QuickBooks must not both count (Definition of Done, item 7).
    const accounts = [account()];
    const txns = [
      txn({ direction: 'inflow', amount_minor: 875_000 }),
      txn({
        direction: 'inflow',
        amount_minor: 875_000,
        source_system: 'quickbooks',
        reconciliation_status: 'possible_duplicate',
      }),
    ];

    const cash = computeCashPosition(accounts, txns, RATES);
    expect(cash.totalUsdMinor).toBe(875_000);
    expect(cash.heldForReviewUsdMinor).toBe(875_000);
  });

  it('excludes confirmed duplicates too', () => {
    const cash = computeCashPosition(
      [account()],
      [
        txn({ direction: 'inflow', amount_minor: 10_000 }),
        txn({ direction: 'inflow', amount_minor: 10_000, reconciliation_status: 'duplicate_ignored' }),
      ],
      RATES,
    );
    expect(cash.totalUsdMinor).toBe(10_000);
  });

  it('prefers the provider-reported balance and reports the variance', () => {
    const accounts = [account({ opening_balance_minor: 0, reported_balance_minor: 95_000 })];
    const txns = [txn({ direction: 'inflow', amount_minor: 100_000 })];

    const cash = computeCashPosition(accounts, txns, RATES);
    expect(cash.byAccount[0]!.balanceMinor).toBe(95_000);
    expect(cash.byAccount[0]!.varianceMinor).toBe(-5_000);
    expect(cash.unreconciledAccounts).toBe(1);
  });

  it('keeps a credit card out of cash when it is flagged as such', () => {
    const accounts = [
      account({ id: 'acc-us', opening_balance_minor: 500_000 }),
      account({
        id: 'acc-card',
        external_account_id: 'ext-card',
        name: 'Amex',
        type: 'credit_card',
        include_in_cash: false,
        opening_balance_minor: -80_000,
      }),
    ];
    const cash = computeCashPosition(accounts, [], RATES);
    expect(cash.totalUsdMinor).toBe(500_000);
    expect(cash.byAccount).toHaveLength(2);
  });

  it('converts a VND account into the USD total', () => {
    const accounts = [
      account({ id: 'acc-vn', external_account_id: 'ext-vn', currency: 'VND', opening_balance_minor: 100_000_000 }),
    ];
    // 100,000,000 VND at 0.00004 USD/VND = 4,000 USD = 400,000 cents.
    const cash = computeCashPosition(accounts, [], RATES);
    expect(cash.totalUsdMinor).toBe(400_000);
  });

  it('values a currency with no rate at zero rather than 1:1', () => {
    // Treating 1 VND as 1 USD would overstate cash 26,000x. Understating is
    // recoverable; that is not.
    const accounts = [
      account({ id: 'acc-php', external_account_id: 'ext-php', currency: 'PHP', opening_balance_minor: 500_000 }),
    ];
    const cash = computeCashPosition(accounts, [], { USD: 1 });
    expect(cash.totalUsdMinor).toBe(0);
  });
});

// ─── Burn ───────────────────────────────────────────────────────────────────

describe('computeBurnRate', () => {
  it('averages outflow over the last three COMPLETE months', () => {
    const txns = [
      txn({ txn_date: '2026-05-10', amount_minor: 300_000 }),
      txn({ txn_date: '2026-06-10', amount_minor: 300_000 }),
      txn({ txn_date: '2026-07-10', amount_minor: 300_000 }),
    ];
    const burn = computeBurnRate(txns, '2026-08-15', 3, RATES);
    expect(burn.monthlyBurnUsdMinor).toBe(300_000);
    expect(burn.monthsSampled).toBe(3);
  });

  it('ignores the current partial month', () => {
    // On the 2nd, this month holds almost nothing. Averaging it in would halve
    // the apparent burn and roughly double the runway.
    const txns = [
      txn({ txn_date: '2026-05-10', amount_minor: 300_000 }),
      txn({ txn_date: '2026-06-10', amount_minor: 300_000 }),
      txn({ txn_date: '2026-07-10', amount_minor: 300_000 }),
      txn({ txn_date: '2026-08-02', amount_minor: 1_000 }),
    ];
    expect(computeBurnRate(txns, '2026-08-02', 3, RATES).monthlyBurnUsdMinor).toBe(300_000);
  });

  it('excludes internal transfers from burn', () => {
    const txns = [
      txn({ txn_date: '2026-07-10', amount_minor: 300_000 }),
      txn({ txn_date: '2026-07-11', amount_minor: 900_000, is_internal_transfer: true }),
    ];
    expect(computeBurnRate(txns, '2026-08-15', 1, RATES).monthlyBurnUsdMinor).toBe(300_000);
  });

  it('excludes duplicates from burn', () => {
    const txns = [
      txn({ txn_date: '2026-07-10', amount_minor: 300_000 }),
      txn({ txn_date: '2026-07-10', amount_minor: 300_000, reconciliation_status: 'possible_duplicate' }),
    ];
    expect(computeBurnRate(txns, '2026-08-15', 1, RATES).monthlyBurnUsdMinor).toBe(300_000);
  });

  it('reports net burn as zero when the company is cash-positive', () => {
    const txns = [
      txn({ txn_date: '2026-07-10', amount_minor: 100_000, direction: 'outflow' }),
      txn({ txn_date: '2026-07-12', amount_minor: 500_000, direction: 'inflow' }),
    ];
    const burn = computeBurnRate(txns, '2026-08-15', 1, RATES);
    expect(burn.monthlyBurnUsdMinor).toBe(100_000);
    expect(burn.netMonthlyBurnUsdMinor).toBe(0);
  });

  it('flags when there is not a complete month of history yet', () => {
    expect(computeBurnRate([], '2026-08-15', 3, RATES).hasEnoughData).toBe(false);
  });
});

// ─── Runway ─────────────────────────────────────────────────────────────────

describe('computeRunway', () => {
  it('divides cash by burn', () => {
    const burn = computeBurnRate(
      [txn({ txn_date: '2026-07-10', amount_minor: 100_000 })],
      '2026-08-15',
      1,
      RATES,
    );
    const runway = computeRunway(780_000, burn);
    expect(runway.grossMonths).toBeCloseTo(7.8, 5);
  });

  it('returns infinite runway (null) when nothing is going out', () => {
    const burn = computeBurnRate([], '2026-08-15', 3, RATES);
    expect(computeRunway(500_000, burn).grossMonths).toBeNull();
  });

  it('never reports negative runway', () => {
    const burn = computeBurnRate(
      [txn({ txn_date: '2026-07-10', amount_minor: 100_000 })],
      '2026-08-15',
      1,
      RATES,
    );
    expect(computeRunway(-50_000, burn).grossMonths).toBe(0);
  });
});

// ─── Break-even ─────────────────────────────────────────────────────────────

describe('computeBreakEven', () => {
  it('adds the projected remainder of the month to spend already booked', () => {
    // 90 days of outflow at 1,000 cents/day, then 15 days into a 31-day month.
    const txns: Transaction[] = [];
    for (let i = 0; i < 90; i++) {
      const date = new Date(Date.UTC(2026, 7, 15));
      date.setUTCDate(date.getUTCDate() - i);
      txns.push(txn({ txn_date: date.toISOString().slice(0, 10), amount_minor: 1_000 }));
    }

    const be = computeBreakEven(txns, '2026-08-15', RATES);
    expect(be.avgDailyOutflowUsdMinor).toBe(1_000);
    expect(be.daysRemaining).toBe(16); // 31 - 15
    expect(be.expenseToDateUsdMinor).toBe(15_000);
    expect(be.projectedRemainingExpenseUsdMinor).toBe(16_000);
    expect(be.requiredRevenueUsdMinor).toBe(31_000);
  });

  it('reports a gap while short and a surplus once past break-even', () => {
    const short = computeBreakEven(
      [
        txn({ txn_date: '2026-08-05', amount_minor: 100_000 }),
        txn({ txn_date: '2026-08-06', amount_minor: 30_000, direction: 'inflow' }),
      ],
      '2026-08-31',
      RATES,
    );
    expect(short.gapUsdMinor).toBeGreaterThan(0);
    expect(short.surplusUsdMinor).toBe(0);

    const ahead = computeBreakEven(
      [
        txn({ txn_date: '2026-08-05', amount_minor: 10_000 }),
        txn({ txn_date: '2026-08-06', amount_minor: 500_000, direction: 'inflow' }),
      ],
      '2026-08-31',
      RATES,
    );
    expect(ahead.gapUsdMinor).toBe(0);
    expect(ahead.surplusUsdMinor).toBeGreaterThan(0);
  });

  it('excludes internal transfers from both sides', () => {
    const be = computeBreakEven(
      [
        txn({ txn_date: '2026-08-05', amount_minor: 900_000, is_internal_transfer: true }),
        txn({ txn_date: '2026-08-05', amount_minor: 900_000, direction: 'inflow', is_internal_transfer: true }),
      ],
      '2026-08-31',
      RATES,
    );
    expect(be.expenseToDateUsdMinor).toBe(0);
    expect(be.revenueReceivedUsdMinor).toBe(0);
  });
});

// ─── Snapshot and trend ─────────────────────────────────────────────────────

describe('computeSnapshot', () => {
  it('assembles a coherent picture across cash, burn, runway and break-even', () => {
    const accounts = [account({ opening_balance_minor: 1_000_000 })];
    const txns = [
      txn({ txn_date: '2026-06-10', amount_minor: 200_000 }),
      txn({ txn_date: '2026-07-10', amount_minor: 200_000 }),
      txn({ txn_date: '2026-08-05', amount_minor: 50_000 }),
      txn({ txn_date: '2026-08-06', amount_minor: 120_000, direction: 'inflow' }),
    ];

    const snap = computeSnapshot(accounts, txns, '2026-08-15', RATES);
    expect(snap.cash.totalUsdMinor).toBe(1_000_000 - 450_000 + 120_000);
    expect(snap.monthToDate.inflowUsdMinor).toBe(120_000);
    expect(snap.monthToDate.outflowUsdMinor).toBe(50_000);
    expect(snap.netProfitMtdUsdMinor).toBe(70_000);
    expect(snap.runway.grossMonths).not.toBeNull();
  });
});

describe('computeCashTrend', () => {
  it('ends on exactly the headline cash figure', () => {
    // The last point of the sparkline and the number in the tile disagreeing is
    // the fastest way to lose a CEO trust in the whole dashboard.
    const txns = [
      txn({ txn_date: '2026-08-14', amount_minor: 20_000, direction: 'inflow' }),
      txn({ txn_date: '2026-08-13', amount_minor: 5_000 }),
    ];
    const trend = computeCashTrend(500_000, txns, [account()], '2026-08-15', 10, RATES);
    expect(trend[trend.length - 1]!.cashUsdMinor).toBe(500_000);
    expect(trend[trend.length - 1]!.date).toBe('2026-08-15');
    expect(trend).toHaveLength(10);
  });

  it('walks the balance backwards through history', () => {
    const trend = computeCashTrend(
      500_000,
      [txn({ txn_date: '2026-08-15', amount_minor: 100_000, direction: 'inflow' })],
      [account()],
      '2026-08-15',
      3,
      RATES,
    );
    // Before today inflow landed, cash was 400,000.
    expect(trend[trend.length - 2]!.cashUsdMinor).toBe(400_000);
  });
});

describe('computeCashTrend account filtering', () => {
  it('ignores movements on accounts that are not part of cash', () => {
    // A credit-card charge must not move the cash line. It never entered the
    // cash figure, so letting it shift the history draws a past that did not
    // happen — while the final point, anchored on today, still looks correct.
    const accounts = [
      account({ id: 'acc-us', include_in_cash: true }),
      account({
        id: 'acc-card',
        external_account_id: 'ext-card',
        type: 'credit_card',
        include_in_cash: false,
      }),
    ];
    const cardCharge = txn({
      account_id: 'acc-card',
      txn_date: '2026-08-14',
      amount_minor: 250_000,
      direction: 'outflow',
    });

    const withCard = computeCashTrend(500_000, [cardCharge], accounts, '2026-08-15', 5, RATES);
    const withoutCard = computeCashTrend(500_000, [], accounts, '2026-08-15', 5, RATES);

    expect(withCard.map((p) => p.cashUsdMinor)).toEqual(withoutCard.map((p) => p.cashUsdMinor));
  });

  it('ignores movements on deactivated accounts', () => {
    const accounts = [
      account({ id: 'acc-us' }),
      account({ id: 'acc-old', external_account_id: 'ext-old', is_active: false }),
    ];
    const trend = computeCashTrend(
      500_000,
      [txn({ account_id: 'acc-old', txn_date: '2026-08-14', amount_minor: 90_000 })],
      accounts,
      '2026-08-15',
      3,
      RATES,
    );
    expect(trend.every((p) => p.cashUsdMinor === 500_000)).toBe(true);
  });

  it('still tracks movements on accounts that DO count as cash', () => {
    const trend = computeCashTrend(
      500_000,
      [txn({ txn_date: '2026-08-15', amount_minor: 100_000, direction: 'inflow' })],
      [account()],
      '2026-08-15',
      3,
      RATES,
    );
    expect(trend[trend.length - 2]!.cashUsdMinor).toBe(400_000);
  });
});

describe('runway reporting honesty (spec §9)', () => {
  /**
   * Outflow 100k, 100k, 190k. Inflow 150k a month.
   *
   * Revenue (450k) covers spend (390k) across the window, so net burn clamps to
   * zero and net runway is infinite - while the average month still costs
   * 130,000 and the worst costs 190,000. This is the shape that matters.
   */
  function cashPositiveBurn() {
    return computeBurnRate(
      [
        txn({ txn_date: '2026-05-10', amount_minor: 100_000, direction: 'outflow' }),
        txn({ txn_date: '2026-05-12', amount_minor: 150_000, direction: 'inflow' }),
        txn({ txn_date: '2026-06-10', amount_minor: 100_000, direction: 'outflow' }),
        txn({ txn_date: '2026-06-12', amount_minor: 150_000, direction: 'inflow' }),
        txn({ txn_date: '2026-07-10', amount_minor: 190_000, direction: 'outflow' }),
        txn({ txn_date: '2026-07-12', amount_minor: 150_000, direction: 'inflow' }),
      ],
      '2026-08-15',
      3,
      RATES,
    );
  }

  it('never headlines infinity for a company that spends real money', () => {
    // Net runway is mathematically infinite here. Printing "∞" to someone
    // spending six figures a month is the most flattering possible way to be
    // wrong, so the headline falls back to the gross figure.
    const runway = computeRunway(350_000, cashPositiveBurn());

    expect(runway.cashPositive).toBe(true);
    expect(runway.netMonths).toBeNull();
    expect(runway.headlineMonths).not.toBeNull();
    expect(runway.headlineMonths).toBe(runway.grossMonths);
  });

  it('headlines net runway when the company is actually burning', () => {
    const burn = computeBurnRate(
      [
        txn({ txn_date: '2026-06-10', amount_minor: 200_000 }),
        txn({ txn_date: '2026-07-10', amount_minor: 200_000 }),
      ],
      '2026-08-15',
      2,
      RATES,
    );
    const runway = computeRunway(400_000, burn);
    expect(runway.cashPositive).toBe(false);
    expect(runway.headlineMonths).toBe(runway.netMonths);
  });

  it('reports the worst month, not just the average', () => {
    // 190,000 in July against a 130,000 average. A CEO planning on the average
    // is planning on a month that never happened.
    const burn = cashPositiveBurn();
    expect(burn.worstMonthOutflowUsdMinor).toBe(190_000);
    expect(burn.worstMonth).toBe('2026-07-01');

    const runway = computeRunway(350_000, burn);
    expect(runway.worstCaseMonths).toBeCloseTo(350_000 / 190_000, 5);
    expect(runway.worstCaseMonths!).toBeLessThan(runway.grossMonths!);
  });

  it('reports no runway at all when nothing has ever gone out', () => {
    const burn = computeBurnRate([], '2026-08-15', 3, RATES);
    const runway = computeRunway(500_000, burn);
    expect(runway.cashPositive).toBe(false); // no spend is not "cash-positive"
    expect(runway.headlineMonths).toBeNull();
    expect(runway.worstCaseMonths).toBeNull();
  });
});
