import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { computeCashTrend, computeSnapshot, type FinancialSnapshot } from '@/lib/calc/engine';
import { buildNeedsAttention } from '@/lib/alerts/engine';
import { loadUsdRates } from '@/lib/fx';
import { currentMonthRange, today } from '@/lib/dates';
import { formatMoney, formatMonths } from '@/lib/money';
import type { FinancialAccount, Transaction } from '@/lib/types';

/**
 * MVP Plan Day 5 deliverable:
 *
 *   "The home screen answers the 7 questions in spec §21."
 *
 * Spec §21 lists them explicitly:
 *   1. How much cash do we have?
 *   2. How much revenue have we received this month?
 *   3. How much have we spent this month?
 *   4. What is net profit?
 *   5. What is runway?
 *   6. How much revenue is required to break even?
 *   7. What needs attention right now?
 *
 * Each test below answers one of them from the real engine over the real data,
 * and checks the answer is not merely present but usable — a number a CEO could
 * act on, rather than a placeholder, an infinity, or a figure that contradicts
 * another tile on the same screen.
 */
const CONFIGURED = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

describe.skipIf(!CONFIGURED)('CEO home screen answers spec §21 (live database)', () => {
  let db: SupabaseClient;
  let snapshot: FinancialSnapshot;
  let accounts: FinancialAccount[];
  let transactions: Transaction[];
  const asOf = today();

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
    const rates = await loadUsdRates(db, asOf);
    snapshot = computeSnapshot(accounts, transactions, asOf, rates);
  });

  it('Q1 — how much cash do we have', () => {
    expect(Number.isInteger(snapshot.cash.totalUsdMinor)).toBe(true);
    expect(snapshot.cash.byAccount.length).toBeGreaterThan(0);
    console.log(`  Q1 cash                 ${formatMoney(snapshot.cash.totalUsdMinor)}`);
  });

  it('Q2 — how much revenue have we received this month', () => {
    const month = currentMonthRange(asOf);
    expect(snapshot.monthToDate.range.from).toBe(month.from);
    expect(snapshot.monthToDate.inflowUsdMinor).toBeGreaterThanOrEqual(0);
    console.log(`  Q2 revenue MTD          ${formatMoney(snapshot.monthToDate.inflowUsdMinor)}`);
  });

  it('Q3 — how much have we spent this month', () => {
    expect(snapshot.monthToDate.outflowUsdMinor).toBeGreaterThanOrEqual(0);
    console.log(`  Q3 spent MTD            ${formatMoney(snapshot.monthToDate.outflowUsdMinor)}`);
  });

  it('Q4 — what is net profit, and does it reconcile with Q2 and Q3', () => {
    // Three tiles on one screen must agree, or none of them is trusted.
    expect(snapshot.netProfitMtdUsdMinor).toBe(
      snapshot.monthToDate.inflowUsdMinor - snapshot.monthToDate.outflowUsdMinor,
    );
    console.log(`  Q4 net profit MTD       ${formatMoney(snapshot.netProfitMtdUsdMinor)}`);
  });

  it('Q5 — what is runway, stated so a CEO can act on it', () => {
    const { runway, burn } = snapshot;

    if (burn.monthlyBurnUsdMinor > 0) {
      // The company spends real money, so SOME finite runway must be shown.
      // Reporting infinity here — which net runway does whenever revenue
      // happens to cover spend — is the failure this assertion exists to stop.
      expect(runway.headlineMonths).not.toBeNull();
      expect(runway.headlineMonths).toBeGreaterThan(0);
      expect(runway.grossMonths).not.toBeNull();
      expect(runway.worstCaseMonths).not.toBeNull();

      // The downside can never look better than the average case.
      expect(runway.worstCaseMonths!).toBeLessThanOrEqual(runway.grossMonths!);
    }

    console.log(
      `  Q5 runway               ${formatMonths(runway.headlineMonths)}` +
        `  (gross ${formatMonths(runway.grossMonths)}, worst ${formatMonths(runway.worstCaseMonths)}` +
        `${runway.cashPositive ? ', cash-positive' : ''})`,
    );
  });

  it('Q6 — how much revenue is required to break even', () => {
    const be = snapshot.breakEven;

    expect(be.requiredRevenueUsdMinor).toBe(
      be.expenseToDateUsdMinor + be.projectedRemainingExpenseUsdMinor,
    );
    // Gap and surplus are two sides of one number; both positive is incoherent.
    expect(be.gapUsdMinor === 0 || be.surplusUsdMinor === 0).toBe(true);
    expect(be.daysElapsed + be.daysRemaining).toBeGreaterThanOrEqual(28);

    console.log(
      `  Q6 break-even           ${formatMoney(be.requiredRevenueUsdMinor)}` +
        `  (gap ${formatMoney(be.gapUsdMinor)}, surplus ${formatMoney(be.surplusUsdMinor)})`,
    );
  });

  it('Q7 — what needs attention right now', () => {
    const attention = buildNeedsAttention(snapshot, transactions);
    for (const item of attention) {
      expect(item.length).toBeGreaterThan(10); // a sentence, not a code
      console.log(`  Q7 · ${item}`);
    }
    if (attention.length === 0) console.log('  Q7 · nothing needs attention');
  });

  it('the cash trend ends on exactly the cash figure the headline tile shows', () => {
    // A chart whose last point disagrees with the number above it is the
    // fastest way to lose a reader's trust in every other number on the page.
    const trend = computeCashTrend(
      snapshot.cash.totalUsdMinor,
      transactions,
      accounts,
      asOf,
      30,
    );
    expect(trend[trend.length - 1]!.cashUsdMinor).toBe(snapshot.cash.totalUsdMinor);
    expect(trend[trend.length - 1]!.date).toBe(asOf);
  });

  it('excludes the current partial month from burn', () => {
    // Spec §9 wants an honest burn. Including a month that is three days old
    // understates it and flatters runway by the same factor.
    const month = currentMonthRange(asOf);
    expect(snapshot.burn.window.to < month.from).toBe(true);
  });

  it('counts no account twice across the entity and currency breakdowns', () => {
    const byCompany = snapshot.cash.byCompany.reduce((s, c) => s + c.totalUsdMinor, 0);
    const byCurrency = snapshot.cash.byCurrency.reduce((s, c) => s + c.totalUsdMinor, 0);
    expect(byCompany).toBe(snapshot.cash.totalUsdMinor);
    expect(byCurrency).toBe(snapshot.cash.totalUsdMinor);
  });
});
