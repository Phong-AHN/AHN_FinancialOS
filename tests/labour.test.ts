import { describe, expect, it } from 'vitest';
import {
  computeNetProfit,
  computeProjectLabour,
  detectLabourDoubleCount,
  hourlyCostOf,
  type Person,
  type TimeEntry,
} from '@/lib/calc/labour';
import type { Transaction } from '@/lib/types';

function person(over: Partial<Person> = {}): Person {
  return {
    id: 'person-1',
    name: 'Jane',
    kind: 'employee',
    basis: 'salaried',
    annual_cost_minor: 12_000_000, // USD 120,000 loaded
    hourly_cost_minor: null,
    annual_hours: 1880,
    currency: 'USD',
    ...over,
  };
}

let entryCount = 0;
function entry(over: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: `entry-${++entryCount}`,
    person_id: 'person-1',
    project_id: 'proj-1',
    work_date: '2026-05-04',
    hours: 8,
    ...over,
  };
}

let txnCount = 0;
function txn(over: Partial<Transaction> = {}): Transaction {
  const amount = over.amount_minor ?? 100_000;
  return {
    id: `txn-${++txnCount}`,
    account_id: 'acc-1',
    counterparty_id: null,
    txn_date: '2026-05-01',
    posted_at: null,
    amount_minor: amount,
    currency: 'USD',
    direction: 'outflow',
    amount_usd_minor: amount,
    fx_rate: 1,
    description: 'Line',
    category: 'software',
    subcategory: null,
    is_internal_transfer: false,
    project_id: 'proj-1',
    is_recurring: false,
    is_subscription: false,
    source_system: 'manual',
    external_txn_id: `ext-${txnCount}`,
    reconciliation_status: 'unreconciled',
    duplicate_of_id: null,
    manual_import_id: null,
    notes: null,
    raw: null,
    alerted_at: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    signed_minor: -amount,
    signed_usd_minor: -amount,
    ...over,
  } as Transaction;
}

describe('hourlyCostOf', () => {
  it('prices a salaried hour against the hours actually available', () => {
    // USD 120,000 over 1,880 working hours is USD 63.83/hour. Dividing by a
    // hardcoded 2,080 would price it at 57.69 — every hour about a tenth cheap,
    // and every project that person touches quietly more profitable.
    expect(hourlyCostOf(person())).toBeCloseTo(12_000_000 / 1880, 6);
  });

  it('takes an hourly or contractor rate as given', () => {
    expect(
      hourlyCostOf(person({ basis: 'hourly', annual_cost_minor: null, hourly_cost_minor: 9_000 })),
    ).toBe(9_000);
    expect(
      hourlyCostOf(
        person({ basis: 'contractor_rate', annual_cost_minor: null, hourly_cost_minor: 15_000 }),
      ),
    ).toBe(15_000);
  });

  it('returns null, never zero, when the rate is unknown', () => {
    // Zero would make that person's time free, and free time improves every
    // project they touch without anyone noticing.
    expect(hourlyCostOf(person({ annual_cost_minor: null }))).toBeNull();
    expect(
      hourlyCostOf(person({ basis: 'hourly', annual_cost_minor: null, hourly_cost_minor: null })),
    ).toBeNull();
  });
});

describe('computeProjectLabour', () => {
  it('costs logged hours at the right rate', () => {
    const jane = person();
    const labour = computeProjectLabour(
      [entry({ hours: 8 }), entry({ work_date: '2026-05-05', hours: 6.5 })],
      [jane],
    );

    expect(labour.actualHours).toBe(14.5);
    expect(labour.actualCostUsdMinor).toBe(Math.round((12_000_000 / 1880) * 14.5));
    expect(labour.byPerson).toHaveLength(1);
    expect(labour.byPerson[0]!.person.name).toBe('Jane');
  });

  it('splits cost between people at their own rates', () => {
    const jane = person();
    const sam = person({
      id: 'person-2',
      name: 'Sam',
      kind: 'contractor',
      basis: 'contractor_rate',
      annual_cost_minor: null,
      hourly_cost_minor: 10_000, // USD 100/hour
    });

    const labour = computeProjectLabour(
      [entry({ hours: 10 }), entry({ person_id: 'person-2', hours: 10 })],
      [jane, sam],
    );

    const sams = labour.byPerson.find((p) => p.person.name === 'Sam')!;
    expect(sams.costUsdMinor).toBe(100_000);
    expect(labour.actualCostUsdMinor).toBe(
      Math.round((12_000_000 / 1880) * 10) + 100_000,
    );
  });

  it('counts unpriced hours without pretending they were free', () => {
    // The hours are real; their cost is not known. Reporting the cost without
    // disclosing this makes an incomplete figure look complete.
    const unpaid = person({ id: 'person-3', name: 'Unknown rate', annual_cost_minor: null });
    const labour = computeProjectLabour([entry({ person_id: 'person-3', hours: 12 })], [unpaid]);

    expect(labour.actualHours).toBe(12);
    expect(labour.actualCostUsdMinor).toBe(0);
    expect(labour.unpricedHours).toBe(12);
    expect(labour.byPerson[0]!.rateUnknown).toBe(true);
  });

  it('ignores an entry for a person it does not know', () => {
    const labour = computeProjectLabour([entry({ person_id: 'ghost' })], [person()]);
    expect(labour.actualHours).toBe(0);
  });

  it('leaves estimate and budget null until somebody sets them', () => {
    const labour = computeProjectLabour([entry()], [person()]);
    expect(labour.estimatedHours).toBeNull();
    expect(labour.hoursVariance).toBeNull();
    expect(labour.costVarianceUsdMinor).toBeNull();
  });

  it('reports variance against an estimate and a budget', () => {
    const labour = computeProjectLabour([entry({ hours: 40 })], [person()], {
      estimated_hours: 30,
      labour_budget_minor: 200_000,
    });

    expect(labour.hoursVariance).toBe(10); // ten hours over
    expect(labour.costVarianceUsdMinor).toBe(
      Math.round((12_000_000 / 1880) * 40) - 200_000,
    );
  });

  it('records the window the work happened in', () => {
    const labour = computeProjectLabour(
      [
        entry({ work_date: '2026-05-20' }),
        entry({ work_date: '2026-03-02' }),
        entry({ work_date: '2026-07-11' }),
      ],
      [person()],
    );
    expect(labour.firstEntry).toBe('2026-03-02');
    expect(labour.lastEntry).toBe('2026-07-11');
  });

  it('rounds once at the total, not once per timesheet line', () => {
    // A rate that does not divide evenly, logged daily for a year: rounding
    // every line then summing drifts. Rounding the total does not.
    const odd = person({ annual_cost_minor: 10_000_000, annual_hours: 1877 });
    const entries = Array.from({ length: 200 }, (_, i) =>
      entry({ work_date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, hours: 7.5 }),
    );
    const labour = computeProjectLabour(entries, [odd]);
    expect(labour.actualCostUsdMinor).toBe(Math.round((10_000_000 / 1877) * 200 * 7.5));
  });
});

describe('computeNetProfit', () => {
  it('takes labour off the gross', () => {
    const net = computeNetProfit(750_000, 1_250_000, 300_000);
    expect(net.netProfitUsdMinor).toBe(450_000);
    expect(net.netMarginRatio).toBeCloseTo(0.36, 10);
    expect(net.labourShareOfGross).toBeCloseTo(0.4, 10);
  });

  it('can turn a gross profit into a real loss', () => {
    // The whole point of spec §12's net figure: a project can look healthy on
    // direct costs alone and still lose money once the people are counted.
    const net = computeNetProfit(200_000, 1_000_000, 500_000);
    expect(net.netProfitUsdMinor).toBe(-300_000);
    expect(net.netMarginRatio).toBeLessThan(0);
  });

  it('states no margin rather than an infinite one', () => {
    expect(computeNetProfit(-50_000, 0, 50_000).netMarginRatio).toBeNull();
  });
});

describe('detectLabourDoubleCount', () => {
  it('flags a project charged for its people twice', () => {
    // Gusto is already an outflow. Attributing it to a project AND logging
    // hours against that project pays for the same people twice, and the
    // project looks far worse than it is with nothing to explain why.
    const warning = detectLabourDoubleCount(
      [txn({ category: 'people', subcategory: 'us_payroll', amount_minor: 585_000 })],
      300_000,
    );
    expect(warning).not.toBeNull();
    expect(warning!.attributedPayrollUsdMinor).toBe(585_000);
    expect(warning!.transactionCount).toBe(1);
  });

  it('says nothing when payroll was left unattributed', () => {
    // The normal, correct arrangement: payroll stays as company overhead and
    // reaches projects only through the time entries.
    expect(detectLabourDoubleCount([txn({ category: 'software' })], 300_000)).toBeNull();
  });

  it('says nothing when no hours were logged', () => {
    // Attributing payroll directly is a legitimate choice on its own — it only
    // becomes a double count once labour is allocated on top.
    expect(
      detectLabourDoubleCount([txn({ category: 'people' })], 0),
    ).toBeNull();
  });

  it('catches compensation filed under other words', () => {
    for (const category of ['payroll', 'salary', 'contractor_pay', 'commission']) {
      expect(detectLabourDoubleCount([txn({ category })], 1000), category).not.toBeNull();
    }
  });

  it('ignores a payroll row that is a flagged duplicate', () => {
    // It is already excluded from the project's direct costs, so it is not
    // being counted once, let alone twice.
    expect(
      detectLabourDoubleCount(
        [txn({ category: 'people', reconciliation_status: 'possible_duplicate' })],
        1000,
      ),
    ).toBeNull();
  });
});
