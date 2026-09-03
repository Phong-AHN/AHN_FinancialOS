import { describe, expect, it } from 'vitest';
import {
  agingBucket,
  agingReport,
  findLikelySettled,
  projectCash,
  summarise,
  type Obligation,
} from '@/lib/calc/obligations';
import type { Transaction } from '@/lib/types';

let n = 0;
function obligation(over: Partial<Obligation> = {}): Obligation {
  return {
    id: `ob-${++n}`,
    direction: 'inflow',
    counterparty_id: null,
    counterparty_name: 'Acme Corp',
    project_id: null,
    category: null,
    reference: 'INV-001',
    description: 'Website build, phase 2',
    amount_minor: 500_000,
    currency: 'USD',
    contracted_amount_minor: null,
    issued_on: '2026-08-01',
    due_on: '2026-08-31',
    status: 'open',
    settled_txn_id: null,
    settled_on: null,
    is_recurring: false,
    ...over,
  };
}

let t = 0;
function txn(over: Partial<Transaction> = {}): Transaction {
  const amount = over.amount_minor ?? 500_000;
  return {
    id: `txn-${++t}`,
    account_id: 'acc-1',
    counterparty_id: null,
    txn_date: '2026-08-31',
    posted_at: null,
    amount_minor: amount,
    currency: 'USD',
    direction: 'inflow',
    amount_usd_minor: amount,
    fx_rate: 1,
    description: 'Payment',
    category: 'revenue',
    subcategory: null,
    is_internal_transfer: false,
    project_id: null,
    is_recurring: false,
    is_subscription: false,
    source_system: 'manual',
    external_txn_id: `ext-${t}`,
    reconciliation_status: 'unreconciled',
    duplicate_of_id: null,
    manual_import_id: null,
    notes: null,
    raw: null,
    alerted_at: null,
    created_at: '2026-08-31T00:00:00Z',
    updated_at: '2026-08-31T00:00:00Z',
    signed_minor: amount,
    signed_usd_minor: amount,
    ...over,
  } as Transaction;
}

describe('agingBucket', () => {
  it('separates not-yet-due from due today', () => {
    // An invoice due next week and one that fell due this morning are in
    // completely different states; a single "current" bucket hides which.
    expect(agingBucket('2026-09-10', '2026-09-01')).toBe('not_due');
    expect(agingBucket('2026-09-01', '2026-09-01')).toBe('current');
  });

  it('places each overdue item in the standard bucket', () => {
    expect(agingBucket('2026-08-31', '2026-09-01')).toBe('d1_30');
    expect(agingBucket('2026-08-02', '2026-09-01')).toBe('d1_30');
    expect(agingBucket('2026-08-01', '2026-09-01')).toBe('d31_60');
    // 2 July to 1 September is 61 days, not 60 — the boundary sits between
    // these two, and getting it wrong shifts a whole bucket of invoices.
    expect(agingBucket('2026-07-03', '2026-09-01')).toBe('d31_60');
    expect(agingBucket('2026-07-02', '2026-09-01')).toBe('d61_90');
    expect(agingBucket('2026-06-15', '2026-09-01')).toBe('d61_90');
    expect(agingBucket('2026-01-01', '2026-09-01')).toBe('d90_plus');
  });
});

describe('agingReport', () => {
  it('leaves settled invoices out of the buckets', () => {
    // A paid invoice sitting in a 90-day bucket makes a collections problem
    // look worse than it is.
    const lines = agingReport(
      [
        obligation({ due_on: '2026-01-01', status: 'settled', settled_on: '2026-02-01' }),
        obligation({ due_on: '2026-01-01', status: 'open' }),
      ],
      '2026-09-01',
    );
    const old = lines.find((l) => l.bucket === 'd90_plus')!;
    expect(old.count).toBe(1);
  });

  it('leaves void rows out entirely', () => {
    const lines = agingReport([obligation({ status: 'void' })], '2026-09-01');
    expect(lines.every((l) => l.count === 0)).toBe(true);
  });

  it('always returns every bucket, so a table has no holes', () => {
    const lines = agingReport([], '2026-09-01');
    expect(lines).toHaveLength(6);
    expect(lines.every((l) => l.amountUsdMinor === 0)).toBe(true);
  });

  it('converts a non-USD obligation at the supplied rate', () => {
    const lines = agingReport(
      [obligation({ currency: 'VND', amount_minor: 25_000_000, due_on: '2026-09-10' })],
      '2026-09-01',
      { USD: 1, VND: 0.00004 },
    );
    expect(lines.find((l) => l.bucket === 'not_due')!.amountUsdMinor).toBe(100_000);
  });

  it('counts a currency with no rate as zero rather than one-to-one', () => {
    // Understating what is owed is recoverable. A 25,000x overstatement of a
    // dong commitment is not.
    const lines = agingReport(
      [obligation({ currency: 'VND', amount_minor: 25_000_000, due_on: '2026-09-10' })],
      '2026-09-01',
      { USD: 1 },
    );
    expect(lines.find((l) => l.bucket === 'not_due')!.amountUsdMinor).toBe(0);
  });
});

describe('summarise', () => {
  it('splits due from overdue and reports the oldest', () => {
    const summary = summarise(
      [
        obligation({ due_on: '2026-09-30', amount_minor: 100_000 }),
        obligation({ due_on: '2026-08-01', amount_minor: 300_000 }),
        obligation({ due_on: '2026-06-01', amount_minor: 200_000 }),
        obligation({ status: 'settled', settled_on: '2026-08-15', amount_minor: 700_000 }),
      ],
      '2026-09-01',
    );

    expect(summary.dueUsdMinor).toBe(100_000);
    expect(summary.overdueUsdMinor).toBe(500_000);
    expect(summary.overdueCount).toBe(2);
    expect(summary.paidUsdMinor).toBe(700_000);
    expect(summary.oldestOverdueDays).toBe(92);
  });

  it('falls back to the amount when no contract figure was recorded', () => {
    // A commitment with no separate contract value was still contracted for
    // what it says; treating that as zero contracted would be a lie.
    const summary = summarise([obligation({ contracted_amount_minor: null })], '2026-08-01');
    expect(summary.contractedUsdMinor).toBe(500_000);
  });

  it('keeps contracted and invoiced apart when only part is billed', () => {
    const summary = summarise(
      [obligation({ amount_minor: 200_000, contracted_amount_minor: 900_000 })],
      '2026-08-01',
    );
    expect(summary.contractedUsdMinor).toBe(900_000);
    expect(summary.invoicedUsdMinor).toBe(200_000);
  });

  it('ignores void rows', () => {
    const summary = summarise([obligation({ status: 'void' })], '2026-09-01');
    expect(summary.count).toBe(0);
    expect(summary.invoicedUsdMinor).toBe(0);
  });
});

describe('projectCash', () => {
  const payable = (amount: number, due: string, label = 'Bill') =>
    obligation({ direction: 'outflow', amount_minor: amount, due_on: due, description: label });

  it('subtracts what is owed and leaves receivables out of the headline', () => {
    // The asymmetry is the point. A bill is a promise the company has to keep;
    // an invoice is a promise somebody else made to it.
    const p = projectCash(
      20_000_000,
      [payable(18_000_000, '2026-09-05', 'Payroll'), obligation({ amount_minor: 9_000_000, due_on: '2026-09-10' })],
      '2026-09-01',
      30,
    );

    expect(p.obligationsDueUsdMinor).toBe(18_000_000);
    expect(p.receivablesDueUsdMinor).toBe(9_000_000);
    expect(p.committedCashUsdMinor).toBe(2_000_000);
    expect(p.withReceivablesUsdMinor).toBe(11_000_000);
  });

  it('names the day the money runs out', () => {
    const p = projectCash(
      1_000_000,
      [payable(400_000, '2026-09-03'), payable(900_000, '2026-09-07')],
      '2026-09-01',
      30,
    );
    expect(p.shortfall).toBe(true);
    expect(p.shortfallDate).toBe('2026-09-07');
  });

  it('reports no shortfall when the obligations are covered', () => {
    const p = projectCash(1_000_000, [payable(400_000, '2026-09-03')], '2026-09-01', 30);
    expect(p.shortfall).toBe(false);
    expect(p.shortfallDate).toBeNull();
  });

  it('ignores obligations beyond the horizon', () => {
    const p = projectCash(1_000_000, [payable(900_000, '2026-12-01')], '2026-09-01', 30);
    expect(p.obligationsDueUsdMinor).toBe(0);
  });

  it('keeps something already overdue in the projection, dated today', () => {
    // It still has to be paid. Dating it backwards would drop it off the chart
    // and out of the figure a person plans against.
    const p = projectCash(1_000_000, [payable(300_000, '2026-08-01')], '2026-09-01', 30);
    expect(p.obligationsDueUsdMinor).toBe(300_000);
    expect(p.timeline[0]!.date).toBe('2026-09-01');
  });

  it('leaves settled and void obligations out', () => {
    const p = projectCash(
      1_000_000,
      [
        obligation({ direction: 'outflow', status: 'settled', settled_on: '2026-08-20', due_on: '2026-09-05' }),
        obligation({ direction: 'outflow', status: 'void', due_on: '2026-09-05' }),
      ],
      '2026-09-01',
      30,
    );
    expect(p.obligationsDueUsdMinor).toBe(0);
  });
});

describe('findLikelySettled', () => {
  it('finds the payment that already settled an open invoice', () => {
    // Until somebody marks it settled, projected cash subtracts the bill a
    // second time — telling a company that has already paid its rent that it
    // still has to.
    const matches = findLikelySettled(
      [obligation({ amount_minor: 500_000, due_on: '2026-08-31' })],
      [txn({ amount_minor: 500_000, txn_date: '2026-09-02' })],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.daysApart).toBe(2);
  });

  it('will not match across directions', () => {
    // Money going out never settles money owed in.
    const matches = findLikelySettled(
      [obligation({ direction: 'inflow' })],
      [txn({ direction: 'outflow' })],
    );
    expect(matches).toHaveLength(0);
  });

  it('will not match a different amount', () => {
    const matches = findLikelySettled([obligation({ amount_minor: 500_000 })], [txn({ amount_minor: 499_900 })]);
    expect(matches).toHaveLength(0);
  });

  it('will not match outside the window', () => {
    const matches = findLikelySettled(
      [obligation({ due_on: '2026-08-01' })],
      [txn({ txn_date: '2026-09-30' })],
    );
    expect(matches).toHaveLength(0);
  });

  it('never treats a flagged duplicate or a transfer as a payment', () => {
    expect(
      findLikelySettled(
        [obligation()],
        [txn({ reconciliation_status: 'possible_duplicate' })],
      ),
    ).toHaveLength(0);
    expect(findLikelySettled([obligation()], [txn({ is_internal_transfer: true })])).toHaveLength(0);
  });

  it('does not let one payment settle two obligations', () => {
    // Two invoices for the same amount and one payment: at most one of them
    // was paid by it, and claiming both would close an invoice nobody paid.
    const matches = findLikelySettled(
      [obligation({ amount_minor: 500_000 }), obligation({ amount_minor: 500_000 })],
      [txn({ amount_minor: 500_000 })],
    );
    expect(matches).toHaveLength(1);
  });

  it('leaves already-settled obligations alone', () => {
    const matches = findLikelySettled(
      [obligation({ status: 'settled', settled_on: '2026-08-31' })],
      [txn()],
    );
    expect(matches).toHaveLength(0);
  });
});
