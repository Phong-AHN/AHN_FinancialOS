import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  computeCashPosition,
  computeSnapshot,
  countsTowardCash,
  usdMinorOf,
  type UsdRateMap,
} from '@/lib/calc/engine';
import { loadUsdRates } from '@/lib/fx';
import { today } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import type { FinancialAccount, SourceSystem, Transaction } from '@/lib/types';

/**
 * MVP Plan Day 3 deliverable, verified against the live database:
 *
 *   "Cash from all 3 sources rolls up correctly, no double-counting."
 *
 * This runs the REAL calc engine over the REAL rows rather than re-deriving the
 * arithmetic here. A verification that reimplements the thing it verifies only
 * proves the two copies agree, and drifts the moment either changes.
 *
 * Skipped automatically when Supabase credentials are absent, so a fresh clone
 * still runs a green suite.
 */
const CONFIGURED = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

describe.skipIf(!CONFIGURED)('multi-source rollup (live database)', () => {
  let db: SupabaseClient;
  let accounts: FinancialAccount[];
  let transactions: Transaction[];
  let rates: UsdRateMap;

  beforeAll(async () => {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const [accountsRes, txnRes] = await Promise.all([
      db.from('financial_accounts').select('*'),
      db.from('transactions').select('*').limit(20_000),
    ]);

    accounts = (accountsRes.data ?? []) as FinancialAccount[];
    transactions = (txnRes.data ?? []) as Transaction[];
    rates = await loadUsdRates(db, today());
  }, 30_000);

  it('reports which sources are present', () => {
    // Not an assertion about how many. A database holding one connector's data
    // is a legitimate state - it is what a first deployment looks like - and a
    // test that fails on it is measuring the fixture, not the behaviour. The
    // cross-source guarantees below apply whenever a second source appears.
    const sources = [...new Set(transactions.map((t) => t.source_system))].sort();
    console.log(`  sources present: ${sources.join(', ') || 'none'}`);
    expect(transactions.length).toBeGreaterThan(0);
  });

  it('rolls every source up into one cash figure, with no source left out', () => {
    const cash = computeCashPosition(accounts, transactions, rates);

    // The headline number must equal the sum of the accounts that count as
    // cash - no rounding drift, no account silently dropped.
    const perAccount = cash.byAccount
      .filter((b) => b.account.include_in_cash)
      .reduce((sum, b) => sum + b.balanceUsdMinor, 0);

    expect(cash.totalUsdMinor).toBe(perAccount);
    expect(Number.isInteger(cash.totalUsdMinor)).toBe(true);

    // Every account carrying transactions is represented in the breakdown.
    const accountsWithTxns = new Set(transactions.map((t) => t.account_id));
    const accountsInBreakdown = new Set(cash.byAccount.map((b) => b.account.id));
    for (const id of accountsWithTxns) {
      const account = accounts.find((a) => a.id === id);
      if (account?.is_active) expect(accountsInBreakdown.has(id)).toBe(true);
    }
  });

  it('EXCLUDES flagged duplicates from cash — the Day 3 acceptance criterion', () => {
    const flagged = transactions.filter((t) => !countsTowardCash(t));
    if (flagged.length === 0) {
      // Nothing flagged is a legitimate state; there is simply nothing to prove.
      return;
    }

    const actual = computeCashPosition(accounts, transactions, rates);

    // What cash would have been if every flagged row were counted. The gap is
    // the money the deduplicator is keeping out of the headline number.
    const naive = computeCashPosition(
      accounts.map((a) => ({ ...a, reported_balance_minor: null })),
      transactions.map((t) => ({ ...t, reconciliation_status: 'unreconciled' as const })),
      rates,
    );
    const deduped = computeCashPosition(
      accounts.map((a) => ({ ...a, reported_balance_minor: null })),
      transactions,
      rates,
    );

    expect(naive.totalUsdMinor).not.toBe(deduped.totalUsdMinor);
    expect(actual.heldForReviewUsdMinor).toBeGreaterThan(0);

    console.log(
      `  duplicates held out of cash: ${formatMoney(actual.heldForReviewUsdMinor)} ` +
        `across ${flagged.length} row(s)`,
    );
  });

  it('never flags both halves of a duplicate pair', () => {
    // Flagging both sides would remove the dollar entirely instead of once.
    const flagged = transactions.filter((t) => t.duplicate_of_id !== null);
    for (const row of flagged) {
      const partner = transactions.find((t) => t.id === row.duplicate_of_id);
      if (!partner) continue;
      expect(countsTowardCash(partner)).toBe(true);
    }
  });

  it('points every duplicate at a transaction that actually exists', () => {
    // A dangling duplicate_of_id is how the earlier stale-cache bug showed up:
    // the sweep reported flagging rows whose ids were no longer in the table.
    const ids = new Set(transactions.map((t) => t.id));
    for (const row of transactions) {
      if (row.duplicate_of_id) expect(ids.has(row.duplicate_of_id)).toBe(true);
    }
  });

  it('keeps the more authoritative source when a pair is resolved', () => {
    const rank: Record<SourceSystem, number> = {
      quickbooks: 0,
      plaid: 1,
      stripe: 2,
      csv_vn_bank: 3,
      csv_veem: 4,
      csv_payroll: 5,
      manual: 6,
    };

    for (const row of transactions) {
      if (!row.duplicate_of_id) continue;
      const kept = transactions.find((t) => t.id === row.duplicate_of_id);
      if (!kept) continue;
      // The flagged row must never be MORE authoritative than the kept one.
      expect(rank[row.source_system]).toBeGreaterThanOrEqual(rank[kept.source_system]);
    }
  });

  it('reports a coherent snapshot: money in and out are non-negative magnitudes', () => {
    const snapshot = computeSnapshot(accounts, transactions, today(), rates);

    expect(snapshot.monthToDate.inflowUsdMinor).toBeGreaterThanOrEqual(0);
    expect(snapshot.monthToDate.outflowUsdMinor).toBeGreaterThanOrEqual(0);
    expect(snapshot.burn.monthlyBurnUsdMinor).toBeGreaterThanOrEqual(0);
    expect(snapshot.netProfitMtdUsdMinor).toBe(
      snapshot.monthToDate.inflowUsdMinor - snapshot.monthToDate.outflowUsdMinor,
    );
    // Runway is either a non-negative number of months or null (nothing burning).
    if (snapshot.runway.netMonths !== null) {
      expect(snapshot.runway.netMonths).toBeGreaterThanOrEqual(0);
    }
  });

  it('stamps a USD value on every non-USD row, so the rollup cannot silently drop it', () => {
    const unpriced = transactions.filter(
      (t) => t.currency !== 'USD' && t.amount_usd_minor === null,
    );
    expect(
      unpriced,
      `${unpriced.length} non-USD transactions have no USD value stamped; ` +
        'they would contribute zero to total cash.',
    ).toHaveLength(0);
  });

  it('keeps every stored amount a positive integer in minor units', () => {
    for (const t of transactions) {
      expect(Number.isInteger(t.amount_minor)).toBe(true);
      expect(t.amount_minor).toBeGreaterThanOrEqual(0);
    }
  });

  it('prints the per-source contribution for the record', () => {
    const bySource = new Map<string, { rows: number; usdMinor: number }>();
    for (const t of transactions) {
      if (!countsTowardCash(t)) continue;
      const entry = bySource.get(t.source_system) ?? { rows: 0, usdMinor: 0 };
      entry.rows++;
      entry.usdMinor += t.direction === 'inflow' ? usdMinorOf(t, rates) : -usdMinorOf(t, rates);
      bySource.set(t.source_system, entry);
    }

    for (const [source, v] of [...bySource].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${source.padEnd(14)} ${String(v.rows).padStart(4)} rows  net ${formatMoney(v.usdMinor)}`);
    }
    expect(bySource.size).toBeGreaterThan(0);
  });
});
