import { describe, expect, it } from 'vitest';
import {
  classifyCadence,
  detectRecurringCharges,
  scoreAmountStability,
  scoreRegularity,
  summariseSubscriptions,
} from '@/lib/subscriptions';
import type { Transaction } from '@/lib/types';

let counter = 0;
function txn(overrides: Partial<Transaction> = {}): Transaction {
  const amount = overrides.amount_minor ?? 1999;
  return {
    id: `txn-${++counter}`,
    account_id: 'acc-1',
    counterparty_id: 'cp-1',
    txn_date: '2026-01-01',
    posted_at: null,
    amount_minor: amount,
    currency: 'USD',
    direction: 'outflow',
    amount_usd_minor: amount,
    fx_rate: 1,
    description: 'Acme SaaS',
    category: 'software',
    subcategory: null,
    is_internal_transfer: false,
    project_id: null,
    is_recurring: false,
    is_subscription: false,
    source_system: 'plaid',
    external_txn_id: `ext-${counter}`,
    reconciliation_status: 'unreconciled',
    duplicate_of_id: null,
    manual_import_id: null,
    notes: null,
    raw: null,
    alerted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    signed_minor: -amount,
    signed_usd_minor: -amount,
    ...overrides,
  };
}

/** Monthly charges on the 1st, at a fixed price unless overridden per month. */
function monthly(months: string[], amounts?: number[]) {
  return months.map((m, i) =>
    txn({
      txn_date: `${m}-01`,
      amount_minor: amounts?.[i] ?? 1999,
      amount_usd_minor: amounts?.[i] ?? 1999,
    }),
  );
}

describe('detectRecurringCharges', () => {
  const asOf = '2026-06-15';

  it('rejects a vendor billed on a rhythm but never at a price', () => {
    // The false positive that matters most: a supplier used most weeks looks
    // exactly like a subscription to a detector that only scores timing. It
    // is not cancellable, and listing it inflates the recurring-cost headline.
    const found = detectRecurringCharges(
      [
        txn({ txn_date: '2026-05-04', amount_minor: 4_240 }),
        txn({ txn_date: '2026-05-11', amount_minor: 22_300 }),
        txn({ txn_date: '2026-05-18', amount_minor: 890 }),
        txn({ txn_date: '2026-05-25', amount_minor: 15_600 }),
      ].map((t) => ({ ...t, amount_usd_minor: t.amount_minor })),
      { asOf },
    );
    expect(found).toHaveLength(0);
  });

  it('does not call a scattered amount a price change', () => {
    // Even when such a vendor squeaks past the threshold, the latest amount is
    // the latest purchase — claiming the price "rose 391%" would be false.
    const found = detectRecurringCharges(
      [
        txn({ txn_date: '2026-04-01', amount_minor: 2_000 }),
        txn({ txn_date: '2026-05-01', amount_minor: 2_000 }),
        txn({ txn_date: '2026-06-01', amount_minor: 2_600 }),
        txn({ txn_date: '2026-06-01', amount_minor: 900, id: 'extra' }),
      ].map((t) => ({ ...t, amount_usd_minor: t.amount_minor })),
      { asOf, minConfidence: 0.1 },
    );
    for (const c of found) {
      if (c.amountStability < 0.7) {
        expect(c.priceChange).toBeNull();
        expect(c.priceChangedOn).toBeNull();
        expect(c.previousAmountUsdMinor).toBeNull();
      }
    }
  });

  it('finds a monthly charge from the payment pattern alone', () => {
    // Nothing here is flagged is_subscription. That flag only ever finds
    // vendors already written into the rule list, and the expensive surprises
    // are the tools nobody remembered signing up for.
    const found = detectRecurringCharges(
      monthly(['2026-03', '2026-04', '2026-05', '2026-06']),
      { asOf },
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.cadence).toBe('monthly');
    expect(found[0]!.occurrences).toBe(4);
    expect(found[0]!.currentAmountUsdMinor).toBe(1999);
    expect(found[0]!.annualisedUsdMinor).toBe(1999 * 12);
  });

  it('reports a price rise with the amount it rose from', () => {
    const found = detectRecurringCharges(
      monthly(['2026-03', '2026-04', '2026-05', '2026-06'], [1999, 1999, 2499, 2499]),
      { asOf },
    );

    expect(found[0]!.previousAmountUsdMinor).toBe(1999);
    expect(found[0]!.currentAmountUsdMinor).toBe(2499);
    expect(found[0]!.priceChange).toBeCloseTo(0.2501, 3);
    expect(found[0]!.priceChangedOn).toBe('2026-05-01');
  });

  it('ignores a cent of wobble as not a price change', () => {
    // A currency-converted charge moves a cent or two every month without the
    // price having moved at all. Reporting that would bury the real increases.
    const found = detectRecurringCharges(
      monthly(['2026-03', '2026-04', '2026-05', '2026-06'], [1999, 2000, 1999, 2001]),
      { asOf },
    );
    expect(found[0]!.priceChange).toBeNull();
  });

  it('rejects irregular spending that merely repeats', () => {
    // Three coffees in a month is not a subscription.
    const found = detectRecurringCharges(
      [
        txn({ txn_date: '2026-06-02', amount_minor: 1200 }),
        txn({ txn_date: '2026-06-03', amount_minor: 1200 }),
        txn({ txn_date: '2026-06-19', amount_minor: 1200 }),
      ],
      { asOf },
    );
    expect(found).toHaveLength(0);
  });

  it('never treats an internal transfer as a subscription', () => {
    // Funding the VN account every month is regular, and is not a cost.
    const found = detectRecurringCharges(
      monthly(['2026-03', '2026-04', '2026-05', '2026-06']).map((t) => ({
        ...t,
        is_internal_transfer: true,
      })),
      { asOf },
    );
    expect(found).toHaveLength(0);
  });

  it('never counts a flagged duplicate', () => {
    const rows = monthly(['2026-03', '2026-04', '2026-05', '2026-06']).map((t) => ({
      ...t,
      reconciliation_status: 'possible_duplicate' as const,
    }));
    expect(detectRecurringCharges(rows, { asOf })).toHaveLength(0);
  });

  it('collapses same-day lines into one event', () => {
    // A charge and its fee are two rows and one event. Left separate, they put
    // a zero-day gap in the middle of the interval maths.
    const found = detectRecurringCharges(
      [
        ...monthly(['2026-03', '2026-04', '2026-05']),
        txn({ txn_date: '2026-05-01', amount_minor: 100, amount_usd_minor: 100 }),
        ...monthly(['2026-06']),
      ],
      { asOf },
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.occurrences).toBe(4);
    expect(found[0]!.cadence).toBe('monthly');
  });

  it('annualises an annual charge as itself, not twelve times over', () => {
    const found = detectRecurringCharges(
      [
        txn({ txn_date: '2024-06-01', amount_minor: 24_900 }),
        txn({ txn_date: '2025-06-01', amount_minor: 24_900 }),
        txn({ txn_date: '2026-06-01', amount_minor: 24_900 }),
      ],
      { asOf },
    );
    expect(found[0]!.cadence).toBe('annual');
    expect(found[0]!.annualisedUsdMinor).toBe(24_900);
    expect(found[0]!.monthlyEquivalentUsdMinor).toBe(2075);
  });

  it('predicts the next charge and reports how overdue it is', () => {
    // Charges on the 1st of March, April and May give gaps of 31 and 30 days.
    // The median lands on 31, so the next one is predicted for 1 June — the
    // right calendar date for a charge that bills at the start of the month.
    const found = detectRecurringCharges(monthly(['2026-03', '2026-04', '2026-05']), {
      asOf: '2026-06-20',
    });
    expect(found[0]!.nextExpected).toBe('2026-06-01');
    expect(found[0]!.daysOverdue).toBe(19);
  });
});

describe('scoreAmountStability', () => {
  it('scores a fixed price perfectly', () => {
    expect(scoreAmountStability([1999, 1999, 1999])).toBe(1);
  });

  it('still scores perfectly across one price change', () => {
    // A genuine increase is a step between two price points, not instability.
    expect(scoreAmountStability([1999, 1999, 2499, 2499])).toBe(1);
  });

  it('scores a vendor with scattered amounts at zero', () => {
    // A hardware store visited every week: a rhythm, but no price.
    expect(scoreAmountStability([4240, 22300, 890, 15600])).toBe(0);
  });

  it('gives a one-off amount no credit as a price point', () => {
    // Two charges at $19.99 and one at $85 is a subscription plus a purchase,
    // not a vendor with two prices.
    expect(scoreAmountStability([1999, 1999, 8500])).toBeCloseTo(2 / 3, 5);
  });
});

describe('classifyCadence', () => {
  it('maps real-world gaps to the right band', () => {
    expect(classifyCadence(7)).toBe('weekly');
    expect(classifyCadence(28)).toBe('monthly');
    expect(classifyCadence(31)).toBe('monthly');
    expect(classifyCadence(91)).toBe('quarterly');
    expect(classifyCadence(365)).toBe('annual');
    expect(classifyCadence(17)).toBe('irregular');
  });
});

describe('scoreRegularity', () => {
  it('scores even gaps high and erratic ones low', () => {
    expect(scoreRegularity([30, 30, 31], 30)).toBeGreaterThan(0.95);
    expect(scoreRegularity([3, 40, 12], 12)).toBeLessThan(0.5);
  });

  it('is cautious about a single gap', () => {
    expect(scoreRegularity([30], 30)).toBe(0.5);
    expect(scoreRegularity([17], 17)).toBe(0.2);
  });
});

describe('summariseSubscriptions', () => {
  const asOf = '2026-06-15';

  it('totals only what is still running', () => {
    const charges = detectRecurringCharges(
      [
        ...monthly(['2026-03', '2026-04', '2026-05', '2026-06']),
        // A vendor that stopped billing back in December.
        ...['2025-10', '2025-11', '2025-12'].map((m) =>
          txn({
            txn_date: `${m}-01`,
            counterparty_id: 'cp-2',
            description: 'Gone SaaS',
            amount_minor: 5000,
          }),
        ),
      ],
      { asOf },
    );

    const summary = summariseSubscriptions(charges, asOf);
    expect(summary.count).toBe(1);
    expect(summary.monthlyRecurringUsdMinor).toBe(1999);
    expect(summary.lapsed).toHaveLength(1);
    expect(summary.lapsed[0]!.vendorName).toBe('Gone SaaS');
  });

  it('flags two tools in one category without claiming a saving', () => {
    // Two tools in one category might both be needed, so this is a prompt for
    // a person, never a number to bank.
    const charges = detectRecurringCharges(
      [
        ...monthly(['2026-03', '2026-04', '2026-05', '2026-06']),
        ...['2026-03', '2026-04', '2026-05', '2026-06'].map((m) =>
          txn({
            txn_date: `${m}-02`,
            counterparty_id: 'cp-3',
            description: 'Rival SaaS',
            amount_minor: 3000,
          }),
        ),
      ],
      { asOf },
    );

    const summary = summariseSubscriptions(charges, asOf);
    expect(summary.possibleDuplicates).toHaveLength(1);
    expect(summary.lapsedAnnualUsdMinor).toBe(0); // nothing has stopped
  });
});
