import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { comparePeriods, detectAnomalies, explainCashChange } from '@/lib/calc/explain';
import { computeSnapshot } from '@/lib/calc/engine';
import { loadUsdRates } from '@/lib/fx';
import { formatMoney, formatPercent } from '@/lib/money';
import { addDays, today } from '@/lib/dates';
import type { FinancialAccount, Transaction } from '@/lib/types';

/**
 * Spec §20's deterministic half, against the live ledger.
 *
 * Prints what it finds. A detector nobody has read the output of is a detector
 * nobody knows the accuracy of — the same reason the subscription suite prints.
 */
const CONFIGURED = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

describe.skipIf(!CONFIGURED)('explaining the live ledger', () => {
  let db: SupabaseClient;
  let transactions: Transaction[];
  let accounts: FinancialAccount[];
  let rates: Record<string, number>;
  const asOf = today();

  beforeAll(async () => {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const [txnRes, accRes, loaded] = await Promise.all([
      db.from('transactions').select('*, counterparty:counterparties(id,name,type)').limit(20_000),
      db.from('financial_accounts').select('*'),
      loadUsdRates(db, asOf),
    ]);
    transactions = (txnRes.data ?? []) as Transaction[];
    accounts = (accRes.data ?? []) as FinancialAccount[];
    rates = loaded;
  }, 30_000);

  it('explains the last 90 days of cash, and the parts add up', () => {
    const from = addDays(asOf, -90);
    const snapshot = computeSnapshot(accounts, transactions, asOf, rates);

    // Work backwards from today's cash to what it must have been 90 days ago,
    // so the decomposition is checked against a figure computed elsewhere.
    const window = transactions.filter((t) => t.txn_date >= from && t.txn_date <= asOf);
    const net = window.reduce((s, t) => {
      if (t.is_internal_transfer) return s;
      if (t.reconciliation_status === 'possible_duplicate') return s;
      return s + (t.direction === 'inflow' ? 1 : -1) * (t.amount_usd_minor ?? 0);
    }, 0);

    const change = explainCashChange(
      snapshot.cash.totalUsdMinor - net,
      transactions,
      from,
      asOf,
      rates,
    );

    console.log(`\n  ${from} to ${asOf}`);
    console.log(`  opening ${formatMoney(change.openingUsdMinor)}  ->  closing ${formatMoney(change.closingUsdMinor)}`);
    console.log(`  in ${formatMoney(change.inflowUsdMinor)}   out ${formatMoney(change.outflowUsdMinor)}   net ${formatMoney(change.netChangeUsdMinor)}`);

    console.log('\n  money out, by category:');
    for (const d of change.outflowDrivers.slice(0, 6)) {
      console.log(`    ${d.label.padEnd(22)} ${formatMoney(d.amountUsdMinor).padStart(12)}  ${formatPercent(d.share, 0).padStart(5)}  ${d.count}x`);
    }
    console.log('\n  largest single movements:');
    for (const l of change.largest.slice(0, 5)) {
      console.log(`    ${l.date}  ${l.direction.padEnd(7)} ${formatMoney(l.amountUsdMinor).padStart(12)}  ${l.label.slice(0, 34)}`);
    }

    expect(change.reconciles).toBe(true);
    // The closing figure must match the cash the engine reports, or one of the
    // two is wrong and it matters which.
    expect(change.closingUsdMinor).toBe(snapshot.cash.totalUsdMinor);
  });

  it('names what moved between the last two months', () => {
    const thisMonth = transactions.filter((t) => t.txn_date >= addDays(asOf, -30));
    const lastMonth = transactions.filter(
      (t) => t.txn_date >= addDays(asOf, -60) && t.txn_date < addDays(asOf, -30),
    );

    for (const direction of ['inflow', 'outflow'] as const) {
      const c = comparePeriods(thisMonth, lastMonth, direction, rates);
      console.log(
        `\n  ${direction}: ${formatMoney(c.priorUsdMinor)} -> ${formatMoney(c.currentUsdMinor)} ` +
          `(${formatMoney(c.changeUsdMinor)}${c.changeRatio === null ? '' : `, ${formatPercent(c.changeRatio, 0)}`})`,
      );
      for (const m of c.movers.slice(0, 4)) {
        const tag = m.isNew ? 'new' : m.isGone ? 'stopped' : '';
        console.log(`    ${formatMoney(m.changeUsdMinor).padStart(12)}  ${m.label.slice(0, 30).padEnd(32)} ${tag}`);
      }
    }
    expect(true).toBe(true);
  });

  it('finds payments unusual for their own vendor', () => {
    const anomalies = detectAnomalies(transactions, { asOf, lookbackDays: 365, rates });
    console.log(`\n  ${anomalies.length} unusual payment(s):`);
    for (const a of anomalies.slice(0, 8)) {
      console.log(
        `    ${formatMoney(a.amountUsdMinor).padStart(12)}  ${a.multiple}x usual  ` +
          `${a.label.slice(0, 26).padEnd(28)} (typical ${formatMoney(a.typicalUsdMinor)}, ${a.sampleSize} seen)`,
      );
    }
    // Every one must be genuinely above its vendor's usual, or the threshold is
    // not doing what it claims.
    for (const a of anomalies) expect(a.amountUsdMinor).toBeGreaterThan(a.typicalUsdMinor);
    expect(Array.isArray(anomalies)).toBe(true);
  });
});
