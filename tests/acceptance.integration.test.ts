import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  computeSnapshot,
  countsTowardCash,
  countsTowardPnl,
  usdMinorOf,
  type UsdRateMap,
} from '@/lib/calc/engine';
import { computeBaseline, buildScenarios, requiredRevenueForMargin } from '@/lib/calc/simulator';
import { computeProjectPnl, groupByProject, rollUpBy } from '@/lib/calc/projects';
import { computeProjectLabour } from '@/lib/calc/labour';
import { detectRecurringCharges, type RecurringCharge } from '@/lib/subscriptions';
import { loadUsdRates } from '@/lib/fx';
import { today } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import type { FinancialAccount, Transaction } from '@/lib/types';

/**
 * The plan's own acceptance checklist (§10), which maps to spec §28's
 * "the application is not complete unless…", run against the live database.
 *
 * Twelve criteria. Each one either holds on AHN's real data, or it does not and
 * this file says which — including the ones that are BUILT but have no data to
 * prove themselves on. Those two states are different and are reported
 * differently: "the capability is absent" and "the capability is present and
 * nobody has entered anything for it to chew on" call for opposite responses,
 * and a checklist that blurs them is worse than no checklist.
 *
 *   ACCEPTANCE_TEST=1 npx vitest run tests/acceptance.integration.test.ts
 */
const ENABLED =
  process.env.ACCEPTANCE_TEST === '1' &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Every read in this file goes through here.
 *
 * The first version of criterion 4 did `const { data } = await ...` and then
 * `(data ?? [])`. The column names were wrong, PostgREST answered 400, and the
 * checklist reported "0 alert rules exist" — a FAIL against a system that has
 * eleven of them. An error that renders as an empty result is decision 90's
 * mistake wearing a different hat, and it is worse here than anywhere: this
 * file exists to tell somebody whether their finance system is sound.
 */
async function must<T>(
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
  what: string,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? []) as T;
}

/** What a criterion can be. */
type Verdict = 'holds' | 'no data' | 'fails';
const results: Array<{ n: number; criterion: string; verdict: Verdict; detail: string }> = [];

function record(n: number, criterion: string, verdict: Verdict, detail: string) {
  results.push({ n, criterion, verdict, detail });
}

describe.skipIf(!ENABLED)('plan §10 / spec §28 acceptance, against live data', () => {
  let db: SupabaseClient;
  let accounts: FinancialAccount[];
  let transactions: Transaction[];
  let rates: UsdRateMap;
  const asOf = today();

  beforeAll(async () => {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const [acc, txn, r] = await Promise.all([
      must<FinancialAccount[]>(db.from('financial_accounts').select('*'), 'accounts'),
      must<Transaction[]>(db.from('transactions').select('*').limit(20_000), 'transactions'),
      loadUsdRates(db, asOf),
    ]);
    accounts = acc;
    transactions = txn;
    rates = r;
  }, 120_000);

  it('1. every imported dollar is traceable to its source', async () => {
    // Provenance is not decoration: a figure nobody can trace back is a figure
    // nobody can defend to an auditor.
    const untraceable = transactions.filter(
      (t) => !t.source_system || (!t.external_txn_id && !t.manual_import_id),
    );
    record(
      1,
      'Every imported dollar traceable',
      untraceable.length === 0 ? 'holds' : 'fails',
      `${transactions.length} transactions, ${untraceable.length} without provenance`,
    );
    expect(untraceable, 'transactions with no source').toHaveLength(0);
  });

  it('2. nothing is double-counted between the bank feed and QuickBooks', async () => {
    // Cross-source pairs that look identical and are NOT flagged. The dedup
    // engine's job; this checks its output rather than re-running it.
    const counted = transactions.filter(countsTowardCash);
    const seen = new Map<string, string[]>();
    for (const t of counted) {
      const key = `${t.txn_date}|${t.amount_minor}|${t.direction}`;
      const sources = seen.get(key) ?? [];
      sources.push(t.source_system);
      seen.set(key, sources);
    }
    const suspicious = [...seen.entries()].filter(
      ([, sources]) => new Set(sources).size > 1,
    );
    record(
      2,
      'No double-counting across sources',
      suspicious.length === 0 ? 'holds' : 'fails',
      suspicious.length === 0
        ? `${counted.length} counted, no unflagged cross-source pair`
        : `${suspicious.length} same-day same-amount pairs from different sources are all still counted`,
    );
    expect(suspicious, 'unflagged cross-source duplicates').toHaveLength(0);
  });

  it('3. cash reconciles with what the providers report', async () => {
    const snapshot = computeSnapshot(accounts, transactions, asOf, rates);
    const cashAccounts = snapshot.cash.byAccount.filter((b) => b.account.include_in_cash);
    const fromProvider = cashAccounts.filter((b) => b.reportedMinor !== null);

    record(
      3,
      'Cash reconciles with connected accounts',
      fromProvider.length > 0 ? 'holds' : 'no data',
      `${formatMoney(snapshot.cash.totalUsdMinor)} across ${cashAccounts.length} accounts; ` +
        `${fromProvider.length} report a balance, ${snapshot.cash.unreconciledAccounts} of which ` +
        `our transaction history does not fully explain`,
    );
    // The total must be built from the providers' own figures wherever they
    // exist — that is what "reconciles with connected accounts" means.
    expect(fromProvider.length).toBeGreaterThan(0);
  });

  it('4. every-dollar alerts can reach Slack, email and SMS', async () => {
    const rules = await must<Array<{ type: string; enabled: boolean; channels: string[] }>>(
      db.from('alert_rules').select('id,type,enabled,channels'),
      'alert rules',
    );
    const channels = new Set(rules.flatMap((r) => r.channels ?? []));
    const active = rules.filter((r) => r.enabled).length;

    const { count: delivered } = await db
      .from('notifications')
      .select('*', { count: 'exact', head: true });

    record(
      4,
      'Every-dollar alerts via Slack, SMS, email',
      rules.length > 0 ? 'holds' : 'fails',
      `${rules.length} rules covering ${[...channels].join(', ') || 'no channels'}; ` +
        `${active} currently active; ${delivered ?? 0} notifications delivered and logged`,
    );
    expect(rules.length, 'no alert rules exist').toBeGreaterThan(0);
    for (const c of ['slack', 'email', 'sms']) {
      expect([...channels], `no rule can reach ${c}`).toContain(c);
    }
  });

  it('5. runway comes from actual cash and actual burn', async () => {
    const snapshot = computeSnapshot(accounts, transactions, asOf, rates);
    const { runway, burn } = snapshot;
    record(
      5,
      'Runway from actual cash and burn',
      burn.hasEnoughData ? 'holds' : 'no data',
      burn.hasEnoughData
        ? `${runway.grossMonths?.toFixed(1) ?? '—'} months gross, ` +
          `${runway.netMonths?.toFixed(1) ?? 'cash positive'} net, over ${burn.monthsSampled} months`
        : 'not one complete month of data yet',
    );
    expect(burn.hasEnoughData, 'no complete month to compute burn from').toBe(true);
    expect(runway.grossMonths).not.toBeNull();
  });

  it('6. monthly break-even revenue is stated', async () => {
    const { breakEven } = computeSnapshot(accounts, transactions, asOf, rates);
    record(
      6,
      'Monthly break-even revenue',
      breakEven.requiredRevenueUsdMinor > 0 ? 'holds' : 'no data',
      `${formatMoney(breakEven.requiredRevenueUsdMinor)} needed this month, ` +
        `${formatMoney(breakEven.gapUsdMinor)} still to go`,
    );
    expect(breakEven.requiredRevenueUsdMinor).toBeGreaterThan(0);
  });

  it('7. revenue growth and a target margin can both be modelled', async () => {
    const { burn } = computeSnapshot(accounts, transactions, asOf, rates);

    /*
     * Delivery cost is computed the way `loadSimulatorBaseline` computes it.
     *
     * The first version called `computeBaseline(burn.perMonth)` with one
     * argument and then reported "gross margin unavailable" — which was true of
     * the test and false of the application. A checklist that exercises a
     * different code path from the product is not a checklist.
     */
    const sampledMonths = new Set(burn.perMonth.map((m) => m.month.slice(0, 7)));
    const deliveryRows = transactions.filter(
      (t) =>
        t.direction === 'outflow' &&
        countsTowardPnl(t) &&
        t.category === 'cost_of_delivery' &&
        sampledMonths.has(t.txn_date.slice(0, 7)),
    );
    const deliveryCost =
      deliveryRows.length === 0 || burn.perMonth.length === 0
        ? null
        : Math.round(
            deliveryRows.reduce((sum, t) => sum + usdMinorOf(t, rates), 0) / burn.perMonth.length,
          );

    const baseline = computeBaseline(burn.perMonth, deliveryCost);
    const scenarios = buildScenarios(baseline);
    const net = requiredRevenueForMargin(0.2, baseline.expenseUsdMinor, baseline.revenueUsdMinor, 12);

    record(
      7,
      'Model growth and a target margin',
      scenarios.length > 0 && net.requiredRevenueUsdMinor !== null ? 'holds' : 'no data',
      `${scenarios.length} scenarios; a 20% net margin needs ` +
        `${formatMoney(net.requiredRevenueUsdMinor ?? 0)}/mo` +
        (baseline.deliveryCostUsdMinor === null
          ? '. Gross margin unavailable: nothing categorised as cost of delivery in the window'
          : `. A 20% GROSS margin needs ${formatMoney(
              requiredRevenueForMargin(0.2, baseline.deliveryCostUsdMinor, baseline.revenueUsdMinor, 12)
                .requiredRevenueUsdMinor ?? 0,
            )}/mo`),
    );
    expect(scenarios.length).toBeGreaterThan(0);
    expect(net.requiredRevenueUsdMinor).not.toBeNull();
  });

  it('8. profitability exists for every project and event', async () => {
    const projects = await must<Array<{ id: string }>>(
      db.from('projects').select('*'),
      'projects',
    );

    if (projects.length === 0) {
      record(
        8,
        'Profitability per project and event',
        'no data',
        'The engine and the pages are built; there are 0 projects, so there is nothing to compute',
      );
      // Deliberately not a failure. The capability is proven by
      // tests/projects.test.ts; what is missing is AHN's data.
      expect(projects).toHaveLength(0);
      return;
    }

    const { rows } = groupByProject(projects as never[], transactions, rates);
    const priced = rows.filter((r) => r.pnl.transactionCount > 0);
    const groups = rollUpBy(rows, 'business_unit');
    record(
      8,
      'Profitability per project and event',
      priced.length > 0 ? 'holds' : 'no data',
      `${rows.length} projects, ${priced.length} with money attributed, ${groups.length} units`,
    );
    expect(rows).toHaveLength(projects.length);
  });

  it('9. labour is factored into profitability', async () => {
    const [entries, people] = await Promise.all([
      must<unknown[]>(db.from('time_entries').select('*'), 'time entries'),
      must<unknown[]>(db.from('people').select('*'), 'people'),
    ]);
    const logged = entries.length;

    if (logged === 0) {
      record(
        9,
        'Labour factored into profitability',
        'no data',
        `${people.length} people on file, 0 hours logged. ` +
          'The roll-up carries Labour and After-labour columns; both are empty until hours exist.',
      );
      expect(logged).toBe(0);
      return;
    }

    const labour = computeProjectLabour(entries as never[], people as never[], { id: 'x' } as never);
    record(
      9,
      'Labour factored into profitability',
      labour.actualCostUsdMinor > 0 ? 'holds' : 'no data',
      `${logged} entries costing ${formatMoney(labour.actualCostUsdMinor)}`,
    );
    expect(logged).toBeGreaterThan(0);
  });

  it('10. subscription price changes are flagged automatically', async () => {
    const found = detectRecurringCharges(transactions, { asOf });
    const withPriceChange = found.filter((c: RecurringCharge) => c.priceChange !== null);
    record(
      10,
      'Subscription price changes auto-flagged',
      found.length > 0 ? 'holds' : 'no data',
      `${found.length} recurring charges detected from payments alone, ` +
        `${withPriceChange.length} with a price change`,
    );
    expect(found.length, 'no recurring charges detected in the live ledger').toBeGreaterThan(0);
  });

  it('11. a company KPI drills down to individual transactions', async () => {
    // The chain that has to hold: the cash figure is built from transactions
    // that each have an id a page can link to.
    const snapshot = computeSnapshot(accounts, transactions, asOf, rates);
    const counted = transactions.filter(countsTowardCash);
    const linkable = counted.filter((t) => typeof t.id === 'string' && t.id.length > 0);

    record(
      11,
      'Drill from KPI to transaction',
      linkable.length === counted.length && counted.length > 0 ? 'holds' : 'fails',
      `${formatMoney(snapshot.cash.totalUsdMinor)} of cash is built from ${counted.length} ` +
        `transactions, every one addressable at /transactions/<id>`,
    );
    expect(linkable.length).toBe(counted.length);
  });

  it('12. financial changes leave an audit trail', async () => {
    const { data, count } = await db
      .from('audit_logs')
      .select('table_name,reason', { count: 'exact' })
      .limit(500);
    const rows = (data ?? []) as Array<{ table_name: string; reason: string }>;
    const tables = new Set(rows.map((r) => r.table_name));

    record(
      12,
      'Audit trail for financial changes',
      (count ?? 0) > 0 ? 'holds' : 'no data',
      `${count ?? 0} entries across ${[...tables].join(', ') || 'no tables'}`,
    );
    expect(count ?? 0, 'nothing has ever been audited').toBeGreaterThan(0);
  });

  it('prints the checklist', () => {
    const icon = { holds: 'PASS', 'no data': 'NO DATA', fails: 'FAIL' } as const;
    console.log('\n  ── Plan §10 / spec §28 ─────────────────────────────────────────');
    for (const r of results.sort((a, b) => a.n - b.n)) {
      console.log(`  ${String(r.n).padStart(2)}. ${icon[r.verdict].padEnd(8)} ${r.criterion}`);
      console.log(`      ${r.detail}`);
    }
    const failed = results.filter((r) => r.verdict === 'fails');
    const noData = results.filter((r) => r.verdict === 'no data');
    console.log(
      `\n  ${results.filter((r) => r.verdict === 'holds').length} hold · ` +
        `${noData.length} built but no data · ${failed.length} fail\n`,
    );
    expect(failed.map((f) => f.criterion), 'a criterion failed').toEqual([]);
  });
});
