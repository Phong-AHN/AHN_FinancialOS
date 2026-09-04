import { describe, expect, it } from 'vitest';
import { matchesScope } from '@/lib/calc/budgets';
import type { Transaction } from '@/lib/types';

const txn = (over: Partial<Transaction> = {}): Transaction =>
  ({
    id: 't1',
    account_id: 'a1',
    txn_date: '2026-09-04',
    amount_minor: 100_000,
    currency: 'USD',
    direction: 'outflow',
    amount_usd_minor: 100_000,
    category: 'marketing',
    is_internal_transfer: false,
    reconciliation_status: 'unreconciled',
    duplicate_of_id: null,
    project_id: null,
    ...over,
  }) as Transaction;

const context = {
  departmentCategories: new Map([
    ['mkt', new Set(['marketing', 'events'])],
    ['eng', new Set(['software', 'cost_of_delivery'])],
  ]),
};

describe('department budgets (spec §19)', () => {
  it('counts a transaction in a category the department owns', () => {
    expect(matchesScope(txn(), { scope: 'department', scope_id: 'mkt', scope_key: null }, context)).toBe(true);
  });

  it('does not count another department’s category', () => {
    expect(
      matchesScope(txn({ category: 'software' }), { scope: 'department', scope_id: 'mkt', scope_key: null }, context),
    ).toBe(false);
  });

  it('counts every category the department owns, not just the first', () => {
    expect(
      matchesScope(txn({ category: 'events' }), { scope: 'department', scope_id: 'mkt', scope_key: null }, context),
    ).toBe(true);
  });

  it('treats an uncategorised payment as uncategorised, not as everyone’s', () => {
    // 26 of AHN's transactions have no category. They must not silently land
    // in whichever department is checked first.
    for (const dept of ['mkt', 'eng']) {
      expect(
        matchesScope(txn({ category: null }), { scope: 'department', scope_id: dept, scope_key: null }, context),
      ).toBe(false);
    }
  });

  it('matches nothing when the department is unknown', () => {
    // A budget pointing at a deleted department measures against nothing rather
    // than against everything.
    expect(matchesScope(txn(), { scope: 'department', scope_id: 'gone', scope_key: null }, context)).toBe(false);
    expect(matchesScope(txn(), { scope: 'department', scope_id: null, scope_key: null }, context)).toBe(false);
  });

  it('never counts money coming in', () => {
    expect(
      matchesScope(txn({ direction: 'inflow' }), { scope: 'department', scope_id: 'mkt', scope_key: null }, context),
    ).toBe(false);
  });

  it('never counts a flagged duplicate', () => {
    expect(
      matchesScope(
        txn({ reconciliation_status: 'possible_duplicate' }),
        { scope: 'department', scope_id: 'mkt', scope_key: null },
        context,
      ),
    ).toBe(false);
  });
});
