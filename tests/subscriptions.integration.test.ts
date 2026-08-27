import { beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  cadenceLabel,
  detectRecurringCharges,
  summariseSubscriptions,
  type RecurringCharge,
} from '@/lib/subscriptions';
import { loadUsdRates } from '@/lib/fx';
import { today } from '@/lib/dates';
import { formatMoney, formatPercent } from '@/lib/money';
import type { Transaction } from '@/lib/types';

/**
 * Spec section 8 against the live ledger.
 *
 * Prints what the detector actually finds, so the output is reviewable rather
 * than a bare pass. A detector nobody has read the output of is a detector
 * nobody knows the accuracy of.
 */
const CONFIGURED = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

describe.skipIf(!CONFIGURED)('recurring charges in the live ledger', () => {
  let charges: RecurringCharge[];
  let transactions: Transaction[];
  const asOf = today();

  beforeAll(async () => {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    // The joined counterparty is what names a vendor; without it the detector
    // falls back to bank memos like "Purchase 143".
    const { data } = await db
      .from('transactions')
      .select('*, counterparty:counterparties(id,name,type)')
      .limit(20_000);
    transactions = (data ?? []) as Transaction[];
    const rates = await loadUsdRates(db, asOf);
    charges = detectRecurringCharges(transactions, { asOf, rates });
  }, 30_000);

  it('reports what it found', () => {
    console.log(`\n  ${charges.length} recurring charges in ${transactions.length} transactions\n`);
    for (const c of charges) {
      const change =
        c.priceChange === null ? '' : `  price ${formatPercent(c.priceChange, 0)}`;
      console.log(
        `  ${cadenceLabel(c.cadence).padEnd(10)} ${formatMoney(c.currentAmountUsdMinor).padStart(10)}` +
          `  ${formatMoney(c.annualisedUsdMinor).padStart(11)}/yr  x${String(c.occurrences).padEnd(2)}` +
          `  conf ${c.confidence.toFixed(2)}  ${c.vendorName.slice(0, 30)}${change}`,
      );
    }
    expect(Array.isArray(charges)).toBe(true);
  });

  it('never reports an internal transfer or a duplicate as recurring', () => {
    // The two exclusions that would otherwise turn funding runs and
    // double-counted rows into phantom subscriptions.
    const byId = new Map(transactions.map((t) => [t.id, t]));
    for (const c of charges) {
      for (const id of c.transactionIds) {
        const t = byId.get(id);
        if (!t) continue;
        expect(t.is_internal_transfer, `${c.vendorName} includes a transfer`).toBe(false);
        expect(t.direction, `${c.vendorName} includes an inflow`).toBe('outflow');
        expect(
          ['possible_duplicate', 'duplicate_ignored'].includes(t.reconciliation_status),
          `${c.vendorName} includes a flagged duplicate`,
        ).toBe(false);
      }
    }
  });

  it('annualises consistently with the cadence it reported', () => {
    for (const c of charges) {
      const perYear = 365 / c.intervalDays;
      const expected = Math.round(c.currentAmountUsdMinor * perYear);
      // Named cadences snap to 12/4/52/1 a year, so allow the rounding gap
      // between that and the raw interval.
      const tolerance = Math.max(100, expected * 0.2);
      expect(
        Math.abs(c.annualisedUsdMinor - expected),
        `${c.vendorName}: annualised ${c.annualisedUsdMinor} vs ~${expected}`,
      ).toBeLessThanOrEqual(tolerance);
    }
  });

  it('summarises without double-counting anything into the totals', () => {
    const summary = summariseSubscriptions(charges, asOf);

    const activeSum = charges
      .filter((c) => c.daysOverdue <= c.intervalDays)
      .reduce((s, c) => s + c.monthlyEquivalentUsdMinor, 0);
    expect(summary.monthlyRecurringUsdMinor).toBe(activeSum);

    // A charge cannot be both still running and lapsed.
    const lapsedKeys = new Set(summary.lapsed.map((c) => c.vendorKey));
    for (const c of summary.upcomingRenewals) expect(lapsedKeys.has(c.vendorKey)).toBe(false);

    console.log(
      `\n  monthly recurring ${formatMoney(summary.monthlyRecurringUsdMinor)}` +
        `  ·  annualised ${formatMoney(summary.annualisedUsdMinor)}` +
        `  ·  ${summary.count} active, ${summary.lapsed.length} lapsed` +
        `  ·  ${summary.priceIncreases.length} price increases`,
    );
  });
});
