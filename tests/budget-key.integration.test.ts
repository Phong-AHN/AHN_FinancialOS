import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * A budget's natural key has to match itself - Spec §19, migration 0033.
 *
 * `unique (scope, scope_id, scope_key, period, starts_on)` looked like it made
 * a budget unique per scope and period. It did not: `scope_id` is NULL for a
 * category budget and for a company-wide one, Postgres treats NULLs as
 * DISTINCT in a unique constraint, and so those rows never conflicted with
 * themselves. Every save inserted another, `on conflict` matched nothing, and
 * the live database was carrying six identical rows before this was found.
 *
 * The damage was never "duplicates in a table". `/budgets` sums what the
 * company planned, so saving a $7,500 marketing budget twice told AHN it had
 * planned $15,000.
 *
 *   BUDGET_KEY_TEST=1 npx vitest run tests/budget-key.integration.test.ts
 */
const ENABLED =
  process.env.BUDGET_KEY_TEST === '1' &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

const NAME = 'PROBE key test';
const KEY = {
  scope: 'category',
  scope_key: 'marketing',
  period: 'month',
  starts_on: '2026-09-01',
};

describe.skipIf(!ENABLED)('the budget natural key, as Postgres enforces it', () => {
  let db: SupabaseClient;

  const clean = async () => {
    if (db) await db.from('budgets').delete().eq('name', NAME);
  };

  beforeAll(async () => {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    await clean();
  }, 60_000);

  afterAll(clean, 60_000);

  const save = (amount: number) =>
    db
      .from('budgets')
      .upsert(
        { name: NAME, ...KEY, amount_minor: amount },
        { onConflict: 'scope,scope_id,scope_key,period,starts_on' },
      );

  it('treats two saves of the same scope as one budget, not two', async () => {
    // The whole bug in one assertion. `scope_id` is NULL here, which is the
    // case that used to slip through.
    const first = await save(500_000);
    expect(first.error, first.error?.message).toBeNull();

    const second = await save(750_000);
    expect(second.error, second.error?.message).toBeNull();

    const { data } = await db.from('budgets').select('id,amount_minor').eq('name', NAME);
    const rows = (data ?? []) as Array<{ id: string; amount_minor: number }>;

    expect(rows, 'saving the same scope twice created a second budget').toHaveLength(1);
    expect(rows[0]!.amount_minor, 'the amount was not updated').toBe(750_000);
  }, 60_000);

  it('refuses a plain insert of a budget that already exists', async () => {
    // Not just the upsert path: the constraint itself has to hold, or any code
    // that inserts without `on conflict` reopens the same hole.
    await save(500_000);
    const { error } = await db.from('budgets').insert({ name: NAME, ...KEY, amount_minor: 900_000 });

    expect(error, 'a duplicate budget was inserted').not.toBeNull();
    expect(error!.message.toLowerCase()).toMatch(/duplicate|unique/);
  }, 60_000);
});
