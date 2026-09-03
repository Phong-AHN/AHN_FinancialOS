import { describe, expect, it } from 'vitest';
import {
  budgetTotals,
  computeBudgetStatus,
  currentPeriodStart,
  matchesScope,
  periodEnd,
  periodProgress,
  projectionConfidence,
  type BudgetRow,
} from '@/lib/calc/budgets';
import type { Transaction } from '@/lib/types';

let counter = 0;
function txn(over: Partial<Transaction> & { project_id?: string | null } = {}) {
  const amount = over.amount_minor ?? 100_000;
  return {
    id: `txn-${++counter}`,
    account_id: 'acc-1',
    counterparty_id: null,
    txn_date: '2026-07-10',
    posted_at: null,
    amount_minor: amount,
    currency: 'USD',
    direction: 'outflow',
    amount_usd_minor: amount,
    fx_rate: 1,
    description: 'Spend',
    category: 'marketing',
    subcategory: null,
    is_internal_transfer: false,
    project_id: null,
    is_recurring: false,
    is_subscription: false,
    source_system: 'manual',
    external_txn_id: `ext-${counter}`,
    reconciliation_status: 'unreconciled',
    duplicate_of_id: null,
    manual_import_id: null,
    notes: null,
    raw: null,
    alerted_at: null,
    created_at: '2026-07-10T00:00:00Z',
    updated_at: '2026-07-10T00:00:00Z',
    signed_minor: -amount,
    signed_usd_minor: -amount,
    ...over,
  } as Transaction & { project_id?: string | null };
}

function budget(over: Partial<BudgetRow> = {}): BudgetRow {
  return {
    id: 'b1',
    name: 'Marketing, July',
    scope: 'category',
    scope_id: null,
    scope_key: 'marketing',
    period: 'month',
    starts_on: '2026-07-01',
    amount_minor: 1_000_000,
    currency: 'USD',
    is_active: true,
    ...over,
  };
}

describe('periodEnd', () => {
  it('derives the last day rather than storing it', () => {
    // Stored separately, a month budget could be saved with an end date that is
    // not the end of that month, and every projection off it would be wrong.
    expect(periodEnd('2026-07-01', 'month')).toBe('2026-07-31');
    expect(periodEnd('2026-02-01', 'month')).toBe('2026-02-28');
    expect(periodEnd('2024-02-01', 'month')).toBe('2024-02-29'); // leap year
    expect(periodEnd('2026-07-01', 'quarter')).toBe('2026-09-30');
    expect(periodEnd('2026-01-01', 'year')).toBe('2026-12-31');
  });
});

describe('periodProgress', () => {
  it('counts today as elapsed, because money spent today is spent', () => {
    const p = periodProgress('2026-07-01', 'month', '2026-07-01');
    expect(p.daysElapsed).toBe(1);
    expect(p.daysTotal).toBe(31);
  });

  it('is complete on and after the last day', () => {
    expect(periodProgress('2026-07-01', 'month', '2026-07-31').hasEnded).toBe(true);
    expect(periodProgress('2026-07-01', 'month', '2026-09-01').fractionElapsed).toBe(1);
  });

  it('is zero before the period starts', () => {
    const p = periodProgress('2026-07-01', 'month', '2026-06-15');
    expect(p.fractionElapsed).toBe(0);
    expect(p.hasEnded).toBe(false);
  });
});

describe('projectionConfidence', () => {
  it('is near nothing two days into a month', () => {
    // The failure this exists to stop: one large payment on day two makes a
    // run rate read many times the budget, and a page that prints that number
    // teaches its reader to ignore the column.
    const p = periodProgress('2026-07-01', 'month', '2026-07-02');
    expect(projectionConfidence(p, 1)).toBeLessThan(0.1);
  });

  it('rises with both elapsed time and number of payments', () => {
    const early = periodProgress('2026-07-01', 'month', '2026-07-08');
    const late = periodProgress('2026-07-01', 'month', '2026-07-20');
    expect(projectionConfidence(late, 12)).toBeGreaterThan(projectionConfidence(early, 12));
    expect(projectionConfidence(late, 12)).toBeGreaterThan(projectionConfidence(late, 2));
  });

  it('stays low on lumpy spend however late it is', () => {
    // Two payments do not average out over the rest of a period the way a run
    // rate assumes, even three weeks in.
    const late = periodProgress('2026-07-01', 'month', '2026-07-25');
    expect(projectionConfidence(late, 2)).toBeLessThan(0.5);
  });

  it('is total once the period has ended, because it is no longer a projection', () => {
    const done = periodProgress('2026-07-01', 'month', '2026-08-05');
    expect(projectionConfidence(done, 1)).toBe(1);
  });
});

describe('matchesScope', () => {
  it('counts only spending', () => {
    // A budget is about what goes out. An inflow is not spending, an internal
    // transfer is not spending, and a flagged duplicate is spending that did
    // not happen.
    expect(matchesScope(txn({ direction: 'inflow' }), budget({ scope: 'total' }))).toBe(false);
    expect(matchesScope(txn({ is_internal_transfer: true }), budget({ scope: 'total' }))).toBe(false);
    expect(
      matchesScope(txn({ reconciliation_status: 'possible_duplicate' }), budget({ scope: 'total' })),
    ).toBe(false);
    expect(matchesScope(txn(), budget({ scope: 'total' }))).toBe(true);
  });

  it('matches a category by name', () => {
    expect(matchesScope(txn({ category: 'marketing' }), budget())).toBe(true);
    expect(matchesScope(txn({ category: 'travel' }), budget())).toBe(false);
  });

  it('treats a null category as uncategorised rather than matching everything', () => {
    expect(
      matchesScope(txn({ category: null }), budget({ scope_key: 'uncategorized' })),
    ).toBe(true);
    expect(matchesScope(txn({ category: null }), budget({ scope_key: 'marketing' }))).toBe(false);
  });

  it('reaches a business unit through the project', () => {
    const b = budget({ scope: 'business_unit', scope_id: 'unit-1', scope_key: null });
    const context = {
      projectMeta: new Map([['proj-1', { businessUnitId: 'unit-1', clientId: null }]]),
    };
    expect(matchesScope(txn({ project_id: 'proj-1' }), b, context)).toBe(true);
    expect(matchesScope(txn({ project_id: 'proj-2' }), b, context)).toBe(false);
    // Unattributed overhead belongs to no unit, and guessing would put real
    // money against a team that never spent it.
    expect(matchesScope(txn({ project_id: null }), b, context)).toBe(false);
  });
});

describe('computeBudgetStatus', () => {
  it('measures actual against budget and states what is left', () => {
    const status = computeBudgetStatus(
      budget(),
      [txn({ amount_minor: 300_000 }), txn({ amount_minor: 200_000 })],
      '2026-07-15',
    );
    expect(status.actualUsdMinor).toBe(500_000);
    expect(status.remainingUsdMinor).toBe(500_000);
    expect(status.varianceRatio).toBeCloseTo(-0.5, 10);
    expect(status.overspent).toBe(false);
  });

  it('ignores spending outside the period', () => {
    const status = computeBudgetStatus(
      budget(),
      [txn({ txn_date: '2026-06-30' }), txn({ txn_date: '2026-08-01' }), txn()],
      '2026-08-15',
    );
    expect(status.transactionCount).toBe(1);
  });

  it('ignores spending dated after today', () => {
    // A future-dated row is not spending that has happened. Counting it would
    // charge a period the company has not reached.
    const status = computeBudgetStatus(budget(), [txn({ txn_date: '2026-07-28' })], '2026-07-10');
    expect(status.actualUsdMinor).toBe(0);
  });

  it('projects the final by run rate, and says how much to trust it', () => {
    // Half way through, 500k spent: the run rate says a million.
    const spread = Array.from({ length: 10 }, (_, i) =>
      txn({ txn_date: `2026-07-${String(i + 1).padStart(2, '0')}`, amount_minor: 50_000 }),
    );
    const status = computeBudgetStatus(budget(), spread, '2026-07-16');

    expect(status.actualUsdMinor).toBe(500_000);
    expect(status.projectedFinalUsdMinor).toBeGreaterThan(950_000);
    expect(status.projectedFinalUsdMinor).toBeLessThan(1_060_000);
    expect(status.projectionConfidence).toBeGreaterThan(0.5);
  });

  it('flags a projected overspend before the actual one', () => {
    // The whole point of §19's "alerts before overspend occurs": spending is
    // still inside budget, but the pace is not.
    const heavy = Array.from({ length: 10 }, (_, i) =>
      txn({ txn_date: `2026-07-${String(i + 1).padStart(2, '0')}`, amount_minor: 90_000 }),
    );
    const status = computeBudgetStatus(budget(), heavy, '2026-07-16');

    expect(status.overspent).toBe(false);
    expect(status.projectedToOverspend).toBe(true);
    expect(status.projectedFinalUsdMinor).toBeGreaterThan(1_000_000);
  });

  it('does not project past the end of a finished period', () => {
    // After the period closes there is nothing left to guess: the actual is
    // the final, and extrapolating it would invent spending.
    const status = computeBudgetStatus(budget(), [txn({ amount_minor: 400_000 })], '2026-08-20');
    expect(status.progress.hasEnded).toBe(true);
    expect(status.projectedFinalUsdMinor).toBe(400_000);
    expect(status.projectionConfidence).toBe(1);
  });

  it('reports no variance on a zero budget rather than infinity', () => {
    const status = computeBudgetStatus(budget({ amount_minor: 0 }), [txn()], '2026-07-15');
    expect(status.varianceRatio).toBeNull();
    expect(status.overspent).toBe(true);
  });

  it('converts a non-USD payment at the supplied rate', () => {
    const vnd = txn({ currency: 'VND', amount_minor: 25_000_000, amount_usd_minor: null });
    const status = computeBudgetStatus(budget(), [vnd], '2026-07-15', {}, { USD: 1, VND: 0.00004 });
    expect(status.actualUsdMinor).toBe(100_000);
  });
});

describe('budgetTotals', () => {
  const spent = (amount: number, budgetAmount: number) =>
    computeBudgetStatus(
      budget({ amount_minor: budgetAmount }),
      [txn({ amount_minor: amount, txn_date: '2026-07-05' })],
      '2026-07-20',
    );

  it('sums budget and actual and counts what is over', () => {
    const totals = budgetTotals([spent(1_200_000, 1_000_000), spent(200_000, 500_000)]);
    expect(totals.budgetUsdMinor).toBe(1_500_000);
    expect(totals.actualUsdMinor).toBe(1_400_000);
    expect(totals.overspentCount).toBe(1);
  });

  it('counts at-risk only when the projection is worth believing', () => {
    // A single payment early in a period projects an overspend the maths cannot
    // support. Counting it would fill the tile with false alarms.
    const oneEarlyPayment = computeBudgetStatus(
      budget(),
      [txn({ amount_minor: 400_000, txn_date: '2026-07-02' })],
      '2026-07-03',
    );
    expect(oneEarlyPayment.projectedToOverspend).toBe(true);
    expect(budgetTotals([oneEarlyPayment]).atRiskCount).toBe(0);
  });
});

describe('currentPeriodStart', () => {
  it('aligns to calendar boundaries', () => {
    expect(currentPeriodStart('2026-07-17', 'month')).toBe('2026-07-01');
    expect(currentPeriodStart('2026-07-17', 'quarter')).toBe('2026-07-01');
    expect(currentPeriodStart('2026-05-17', 'quarter')).toBe('2026-04-01');
    expect(currentPeriodStart('2026-12-31', 'quarter')).toBe('2026-10-01');
    expect(currentPeriodStart('2026-07-17', 'year')).toBe('2026-01-01');
  });
});
