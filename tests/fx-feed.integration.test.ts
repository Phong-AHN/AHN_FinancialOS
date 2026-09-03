import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { currenciesInUse, loadRateStatus, loadUsdRates, refreshRates } from '@/lib/fx';
import { fetchQuotes } from '@/lib/fx-feed';
import { today } from '@/lib/dates';

/**
 * The exchange-rate feed against the real bank and the real database.
 *
 * Reaches the public internet and writes a dated row, so it is gated behind
 * FX_FEED_TEST rather than running on every `npm test`. Nothing here is
 * destructive: a rate row is dated and additive by design, and the whole point
 * of the feature is that today's row gets written.
 *
 *   FX_FEED_TEST=1 npx vitest run tests/fx-feed.integration.test.ts
 */
const CONFIGURED = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const ENABLED = CONFIGURED && process.env.FX_FEED_TEST === '1';

describe.skipIf(!ENABLED)('exchange rate feed (live bank, live database)', () => {
  let db: SupabaseClient;

  beforeAll(() => {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
  });

  it('asks only for the currencies the company actually holds', async () => {
    const wanted = await currenciesInUse(db);
    console.log(`\n  currencies to price: ${wanted.join(', ') || '(none)'}`);
    expect(wanted).toContain('VND');
    expect(wanted).not.toContain('USD');
  });

  it('gets a live rate from Vietcombank', async () => {
    const { quotes, problems } = await fetchQuotes(['VND'], { fetchedOn: today() });
    for (const p of problems) console.log(`  problem: ${p}`);

    const vnd = quotes.find((q) => q.currency === 'VND');
    expect(vnd, 'no source priced VND').toBeDefined();
    console.log(
      `  1 VND = ${vnd!.usdPerUnit.toFixed(10)} USD  ` +
        `(${(1 / vnd!.usdPerUnit).toFixed(0)} VND per USD, ${vnd!.source}, as of ${vnd!.asOf})`,
    );

    // The band a managed float lives in. Outside it, something is wrong with
    // the parse rather than with the dong.
    const perUsd = 1 / vnd!.usdPerUnit;
    expect(perUsd).toBeGreaterThan(15_000);
    expect(perUsd).toBeLessThan(40_000);
  });

  it('stores what it fetched, and says what it refused', async () => {
    const before = await loadUsdRates(db, today());
    const result = await refreshRates(db, { asOf: today() });

    console.log(`\n  --- refresh for ${result.asOf} ---`);
    for (const w of result.written) {
      console.log(`   wrote    ${w.currency}  ${w.rate.toFixed(10)}  ${w.source}`);
    }
    for (const c of result.unchanged) console.log(`   same     ${c}`);
    for (const c of result.keptManual) console.log(`   kept     ${c} (a person set it)`);
    for (const r of result.refused) console.log(`   REFUSED  ${r.currency} ${r.rate} — ${r.reason}`);
    for (const p of result.problems) console.log(`   problem  ${p}`);

    // A refusal is the one outcome that must never pass silently: it means a
    // source answered and we did not believe it.
    expect(result.refused, 'a rate was fetched and disbelieved').toEqual([]);
    expect(result.problems.filter((p) => p.startsWith('could not store'))).toEqual([]);

    const after = await loadUsdRates(db, today());
    console.log(`\n  VND before: ${before.VND ?? '(none)'}\n  VND after:  ${after.VND ?? '(none)'}`);
    expect(after.VND, 'VND has no USD rate after a refresh').toBeGreaterThan(0);

    /*
     * Exactly one of these three things must have happened to VND. Asserting
     * only "there is a rate afterwards" would pass on a day a person had
     * already set one and the feed did nothing at all — which is precisely what
     * happened the first time this ran, and it looked green.
     *
     * Which branch runs is not this test's to choose: whether a human has typed
     * today's rate is a fact about the database on the day. So it names the
     * branch it took, and fails if none of them did.
     */
    const outcome = result.written.some((w) => w.currency === 'VND')
      ? 'written'
      : result.keptManual.includes('VND')
        ? 'kept a human rate'
        : result.unchanged.includes('VND')
          ? 'already current'
          : 'nothing';
    console.log(`  VND outcome: ${outcome}`);
    expect(outcome, 'the refresh did nothing at all with VND').not.toBe('nothing');

    if (outcome === 'kept a human rate') {
      // Then prove the feed at least had a usable number to offer, so a passing
      // run still means the source works — not merely that we skipped it.
      const { quotes } = await fetchQuotes(['VND'], { fetchedOn: today() });
      const offered = quotes.find((q) => q.currency === 'VND');
      expect(offered, 'deferred to a human without a working source behind it').toBeDefined();
      const gap = Math.abs(offered!.usdPerUnit - after.VND!) / after.VND!;
      console.log(
        `  the bank offered ${offered!.usdPerUnit.toFixed(10)} ` +
          `(${(gap * 100).toFixed(2)}% from the stored human rate) and was correctly ignored`,
      );
    }
  });

  it('is idempotent — running twice writes the same day once', async () => {
    // The unique key is (base, quote, as_of), so a second run must find its own
    // row and leave it alone rather than stacking duplicates.
    const second = await refreshRates(db, { asOf: today() });
    expect(second.refused).toEqual([]);
    console.log(
      `\n  second run: ${second.written.length} written, ` +
        `${second.unchanged.length} unchanged, ${second.keptManual.length} kept`,
    );

    const { count } = await db
      .from('exchange_rates')
      .select('*', { count: 'exact', head: true })
      .eq('base_currency', 'VND')
      .eq('quote_currency', 'USD')
      .eq('as_of', today());
    expect(count, 'more than one VND row for today').toBe(1);
  });

  it('reports how stale every rate on file is', async () => {
    const status = await loadRateStatus(db, today());
    console.log('\n  --- rates on file ---');
    for (const s of status) {
      console.log(
        `   ${s.currency}  ${s.rate.toFixed(10)}  as of ${s.asOf} ` +
          `(${s.ageDays} day(s) old, ${s.source})`,
      );
    }
    const vnd = status.find((s) => s.currency === 'VND');
    expect(vnd, 'VND missing from the rate table').toBeDefined();
    expect(vnd!.ageDays, 'VND rate is stale after a refresh').toBeLessThanOrEqual(1);
  });
});
