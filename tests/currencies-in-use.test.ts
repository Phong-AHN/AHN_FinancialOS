import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currenciesInUse } from '@/lib/fx';

/**
 * `currenciesInUse` queried a table that does not exist for two days.
 *
 * PostgREST answered 404, `(data ?? [])` made it an empty list, and the daily
 * exchange-rate feed silently priced only the dong. Nothing looked wrong,
 * because VND is the only foreign currency AHN plans to hold — the failure was
 * waiting for the first PHP or SGD account, whose balance would then have been
 * valued at zero.
 *
 * These tests name the table, so the next rename has to update them too.
 */
function stub(rows: Array<{ currency: string | null }>, opts: { table?: string } = {}) {
  const asked: string[] = [];
  const db = {
    from(table: string) {
      asked.push(table);
      return {
        select: () =>
          Promise.resolve(
            table === (opts.table ?? 'financial_accounts')
              ? { data: rows, error: null }
              : // What a wrong table name actually returns.
                { data: null, error: { message: `relation "${table}" does not exist`, code: 'PGRST205' } },
          ),
      };
    },
  } as unknown as SupabaseClient;
  return { db, asked };
}

describe('currenciesInUse', () => {
  it('reads the accounts table by its real name', async () => {
    const { db, asked } = stub([{ currency: 'USD' }]);
    await currenciesInUse(db);
    expect(asked).toEqual(['financial_accounts']);
  });

  it('returns every foreign currency actually held', async () => {
    const { db } = stub([{ currency: 'USD' }, { currency: 'PHP' }, { currency: 'sgd' }]);
    // The bug returned ['VND'] here and nothing else, so PHP and SGD balances
    // would have been valued at zero for ever.
    expect(await currenciesInUse(db)).toEqual(['PHP', 'SGD', 'VND']);
  });

  it('always includes VND and never USD', async () => {
    const { db } = stub([{ currency: 'USD' }]);
    const found = await currenciesInUse(db);
    expect(found).toContain('VND');
    expect(found).not.toContain('USD');
  });

  it('throws instead of pretending the company holds nothing', async () => {
    // The whole point. A failed read must not look like an empty ledger.
    const { db } = stub([], { table: 'some_other_table' });
    await expect(currenciesInUse(db)).rejects.toThrow(/account currencies/);
  });
});
