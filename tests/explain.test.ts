import { describe, expect, it } from 'vitest';
import { comparePeriods, detectAnomalies, explainCashChange } from '@/lib/calc/explain';
import type { Transaction } from '@/lib/types';

let n = 0;
function txn(over: Partial<Transaction> & { counterparty?: { name: string } } = {}) {
  const amount = over.amount_minor ?? 100_000;
  return {
    id: `txn-${++n}`,
    account_id: 'acc-1',
    counterparty_id: null,
    txn_date: '2026-07-15',
    posted_at: null,
    amount_minor: amount,
    currency: 'USD',
    direction: 'outflow',
    amount_usd_minor: amount,
    fx_rate: 1,
    description: 'A payment',
    category: 'software',
    subcategory: null,
    is_internal_transfer: false,
    project_id: null,
    is_recurring: false,
    is_subscription: false,
    source_system: 'manual',
    external_txn_id: `ext-${n}`,
    reconciliation_status: 'unreconciled',
    duplicate_of_id: null,
    manual_import_id: null,
    notes: null,
    raw: null,
    alerted_at: null,
    created_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
    signed_minor: -amount,
    signed_usd_minor: -amount,
    ...over,
  } as Transaction;
}

const vendor = (name: string, amount: number, date = '2026-07-15') =>
  txn({ amount_minor: amount, amount_usd_minor: amount, txn_date: date, counterparty: { name } });

describe('explainCashChange', () => {
  it('adds up exactly, in integer minor units', () => {
    // A breakdown that nearly adds up is worse than none: a reader who checks
    // it once and finds it off by $3 stops trusting anything on the page.
    const change = explainCashChange(
      5_000_000,
      [
        txn({ direction: 'inflow', amount_minor: 1_250_000, amount_usd_minor: 1_250_000 }),
        txn({ amount_minor: 333_333, amount_usd_minor: 333_333 }),
        txn({ amount_minor: 666_667, amount_usd_minor: 666_667 }),
      ],
      '2026-07-01',
      '2026-07-31',
    );

    expect(change.reconciles).toBe(true);
    expect(change.closingUsdMinor).toBe(5_000_000 + 1_250_000 - 1_000_000);
    expect(change.netChangeUsdMinor).toBe(250_000);
    expect(
      change.outflowDrivers.reduce((s, d) => s + d.amountUsdMinor, 0),
      'drivers must sum to the side they describe',
    ).toBe(change.outflowUsdMinor);
  });

  it('counts an internal transfer on neither side', () => {
    // It nets to zero across the whole position. Including it would inflate
    // both sides by the same amount — a breakdown that reconciles and still
    // misleads about how much the company earned and spent.
    const change = explainCashChange(
      1_000_000,
      [
        txn({ direction: 'inflow', is_internal_transfer: true, amount_minor: 500_000, amount_usd_minor: 500_000 }),
        txn({ is_internal_transfer: true, amount_minor: 500_000, amount_usd_minor: 500_000 }),
        txn({ amount_minor: 100_000, amount_usd_minor: 100_000 }),
      ],
      '2026-07-01',
      '2026-07-31',
    );

    expect(change.inflowUsdMinor).toBe(0);
    expect(change.outflowUsdMinor).toBe(100_000);
    expect(change.netChangeUsdMinor).toBe(-100_000);
  });

  it('ignores flagged duplicates and anything outside the window', () => {
    const change = explainCashChange(
      0,
      [
        txn({ txn_date: '2026-06-30' }),
        txn({ txn_date: '2026-08-01' }),
        txn({ reconciliation_status: 'possible_duplicate' }),
        txn({ txn_date: '2026-07-15' }),
      ],
      '2026-07-01',
      '2026-07-31',
    );
    expect(change.outflowDrivers.reduce((s, d) => s + d.count, 0)).toBe(1);
  });

  it('names the largest individual movements', () => {
    const change = explainCashChange(
      0,
      [
        vendor('Small', 1_000),
        vendor('Huge', 900_000),
        vendor('Medium', 50_000),
      ],
      '2026-07-01',
      '2026-07-31',
    );
    expect(change.largest[0]!.label).toBe('Huge');
    expect(change.largest).toHaveLength(3);
  });

  it('has driver shares that add to one on each side', () => {
    const change = explainCashChange(
      0,
      [
        txn({ category: 'software', amount_minor: 300_000, amount_usd_minor: 300_000 }),
        txn({ category: 'people', amount_minor: 700_000, amount_usd_minor: 700_000 }),
      ],
      '2026-07-01',
      '2026-07-31',
    );
    expect(change.outflowDrivers.reduce((s, d) => s + d.share, 0)).toBeCloseTo(1, 10);
  });
});

describe('comparePeriods', () => {
  it('names who moved, not which category', () => {
    // "Revenue fell because professional services fell" tells nobody anything
    // they can act on. "Acme paid $40,000 last month and nothing this month"
    // is a phone call.
    const comparison = comparePeriods(
      [vendor('Acme', 0), vendor('Beta', 500_000)].filter((t) => t.amount_minor > 0),
      [vendor('Acme', 4_000_000), vendor('Beta', 500_000)],
      'outflow',
    );

    expect(comparison.movers[0]!.label).toBe('Acme');
    expect(comparison.movers[0]!.isGone).toBe(true);
    expect(comparison.movers[0]!.changeUsdMinor).toBe(-4_000_000);
  });

  it('marks a counterparty that appeared this period', () => {
    const comparison = comparePeriods([vendor('New Supplier', 200_000)], [], 'outflow');
    expect(comparison.movers[0]!.isNew).toBe(true);
  });

  it('sorts by how much moved, regardless of direction of movement', () => {
    const comparison = comparePeriods(
      [vendor('Up', 900_000), vendor('Down', 10_000)],
      [vendor('Up', 100_000), vendor('Down', 500_000)],
      'outflow',
    );
    expect(comparison.movers[0]!.label).toBe('Up'); // +800k beats -490k
  });

  it('reports no ratio when the prior period was nothing', () => {
    // Growth from zero is undefined, not infinite.
    const comparison = comparePeriods([vendor('X', 100_000)], [], 'outflow');
    expect(comparison.changeRatio).toBeNull();
    expect(comparison.changeUsdMinor).toBe(100_000);
  });

  it('leaves out anything that did not move', () => {
    const comparison = comparePeriods(
      [vendor('Steady', 100_000)],
      [vendor('Steady', 100_000)],
      'outflow',
    );
    expect(comparison.movers).toHaveLength(0);
  });
});

describe('detectAnomalies', () => {
  const history = (name: string, amounts: number[], base = 1) =>
    amounts.map((a, i) => vendor(name, a, `2026-07-${String(base + i).padStart(2, '0')}`));

  it('flags a charge that is unusual for that vendor, not for the company', () => {
    // The whole point. A global $5,000 threshold fires on every payroll run and
    // stays silent on this: a vendor that has never charged more than $20
    // suddenly charging $300.
    const anomalies = detectAnomalies([
      ...history('Coffee Shop', [1_800, 2_000, 1_900, 2_100, 1_950]),
      vendor('Coffee Shop', 30_000, '2026-07-20'),
    ]);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.label).toBe('Coffee Shop');
    expect(anomalies[0]!.multiple).toBeGreaterThan(10);
  });

  it('stays quiet about a large payment that is normal for its vendor', () => {
    // Payroll at $585,000 a month is not news. A flat threshold would report it
    // every single month until nobody read the alerts at all.
    const anomalies = detectAnomalies(
      history('Gusto', [585_000, 585_000, 585_000, 585_000, 585_000]),
    );
    expect(anomalies).toHaveLength(0);
  });

  it('will not judge a vendor it has barely seen', () => {
    // Calling a vendor's second ever payment unusual is noise, and noise here
    // trains people to ignore the one that mattered.
    const anomalies = detectAnomalies([
      vendor('Brand New', 1_000, '2026-07-01'),
      vendor('Brand New', 500_000, '2026-07-02'),
    ]);
    expect(anomalies).toHaveLength(0);
  });

  it('does not report every charge from a genuinely variable supplier', () => {
    // A hardware store whose amounts swing wildly is not anomalous when it
    // swings. Requiring the payment to sit outside the vendor's own spread as
    // well as above its median is what separates the two.
    const anomalies = detectAnomalies(
      history('Hardware Store', [5_000, 80_000, 12_000, 150_000, 40_000, 95_000]),
    );
    expect(anomalies).toHaveLength(0);
  });

  it('is not blinded by one huge charge when judging the next', () => {
    // A mean would be dragged up far enough to swallow the second one. A median
    // does not move — so BOTH are recognised as unusual.
    const anomalies = detectAnomalies([
      ...history('Vendor', [1_000, 1_100, 900, 1_050, 1_000]),
      vendor('Vendor', 500_000, '2026-07-20'),
      vendor('Vendor', 480_000, '2026-07-21'),
    ]);

    // One line per vendor, the largest, with the rest counted rather than
    // repeated — see the note on `alsoUnusualCount`.
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.amountUsdMinor).toBe(500_000);
    expect(anomalies[0]!.alsoUnusualCount).toBe(1);
  });

  it('reports one line per vendor however many payments qualify', () => {
    // Found by running this over the real ledger: all three results were Stripe
    // processing fees, whose size scales with the payment being settled. Three
    // lines about one vendor is the repetition that teaches a reader to skip
    // the list entirely.
    const anomalies = detectAnomalies([
      ...history('Processor', [400, 380, 420, 390, 410]),
      vendor('Processor', 24_680, '2026-07-20'),
      vendor('Processor', 9_310, '2026-07-21'),
      vendor('Processor', 3_655, '2026-07-22'),
    ]);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.alsoUnusualCount).toBe(2);
    // And the reason says why one vendor produced several, rather than leaving
    // the reader to wonder.
    expect(anomalies[0]!.reason).toContain('vary with something');
  });

  it('only surfaces recent oddities', () => {
    // An unusual charge from eight months ago is history, not a thing to act on.
    const anomalies = detectAnomalies(
      [
        ...history('Vendor', [1_000, 1_100, 900, 1_050]),
        vendor('Vendor', 500_000, '2026-01-05'),
      ],
      { asOf: '2026-07-31', lookbackDays: 30 },
    );
    expect(anomalies).toHaveLength(0);
  });

  it('never treats an inflow or a transfer as unusual spending', () => {
    const anomalies = detectAnomalies([
      ...history('Vendor', [1_000, 1_100, 900, 1_050]),
      txn({
        direction: 'inflow',
        amount_minor: 900_000,
        amount_usd_minor: 900_000,
        counterparty: { name: 'Vendor' },
      }),
    ]);
    expect(anomalies).toHaveLength(0);
  });
});
