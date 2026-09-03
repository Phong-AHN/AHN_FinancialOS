import { describe, expect, it } from 'vitest';
import {
  computeProjectPnl,
  groupByProject,
  portfolioTotals,
  rollUpBy,
} from '@/lib/calc/projects';
import type { Transaction } from '@/lib/types';

let counter = 0;
function txn(overrides: Partial<Transaction> & { project_id?: string | null } = {}) {
  const amount = overrides.amount_minor ?? 100_000;
  return {
    id: `txn-${++counter}`,
    account_id: 'acc-1',
    counterparty_id: null,
    txn_date: '2026-05-01',
    posted_at: null,
    amount_minor: amount,
    currency: 'USD',
    direction: 'inflow',
    amount_usd_minor: amount,
    fx_rate: 1,
    description: 'Line',
    category: 'revenue',
    subcategory: null,
    is_internal_transfer: false,
    is_recurring: false,
    is_subscription: false,
    source_system: 'manual',
    external_txn_id: `ext-${counter}`,
    reconciliation_status: 'unreconciled',
    duplicate_of_id: null,
    manual_import_id: null,
    notes: null,
    raw: null,
    alerted_at: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    signed_minor: amount,
    signed_usd_minor: amount,
    ...overrides,
  } as Transaction & { project_id?: string | null };
}

const inflow = (amount: number, over: Partial<Transaction> = {}) =>
  txn({ direction: 'inflow', amount_minor: amount, amount_usd_minor: amount, ...over });
const outflow = (amount: number, over: Partial<Transaction> = {}) =>
  txn({ direction: 'outflow', amount_minor: amount, amount_usd_minor: amount, ...over });

describe('computeProjectPnl', () => {
  it('nets direct cost against cash received', () => {
    const pnl = computeProjectPnl([
      inflow(1_250_000),
      outflow(400_000, { category: 'contractors' }),
      outflow(100_000, { category: 'travel' }),
    ]);

    expect(pnl.cashReceivedUsdMinor).toBe(1_250_000);
    expect(pnl.directExpenseUsdMinor).toBe(500_000);
    expect(pnl.grossProfitUsdMinor).toBe(750_000);
    expect(pnl.grossMarginRatio).toBeCloseTo(0.6, 10);
    expect(pnl.roiRatio).toBeCloseTo(1.5, 10);
  });

  it('never lets an internal transfer become project revenue', () => {
    // Funding the event account from the operating account is not a sponsor.
    const pnl = computeProjectPnl([
      inflow(500_000, { is_internal_transfer: true }),
      inflow(100_000),
    ]);
    expect(pnl.cashReceivedUsdMinor).toBe(100_000);
    expect(pnl.transactionCount).toBe(1);
  });

  it('never lets a flagged duplicate inflate profit', () => {
    const pnl = computeProjectPnl([
      inflow(100_000),
      inflow(100_000, { reconciliation_status: 'possible_duplicate' }),
    ]);
    expect(pnl.cashReceivedUsdMinor).toBe(100_000);
  });

  it('reports no margin at all rather than an infinite one', () => {
    // A project that has spent money and taken none has no margin to state.
    // Dividing by zero received would print Infinity next to a real loss.
    const pnl = computeProjectPnl([outflow(250_000)]);
    expect(pnl.grossProfitUsdMinor).toBe(-250_000);
    expect(pnl.grossMarginRatio).toBeNull();
    expect(pnl.roiRatio).toBeCloseTo(-1, 10);
  });

  it('leaves contracted and invoiced null when nobody has entered them', () => {
    // A zero would read as "nothing was contracted" instead of "nobody said".
    const pnl = computeProjectPnl([inflow(100_000)]);
    expect(pnl.contractedRevenueUsdMinor).toBeNull();
    expect(pnl.invoicedRevenueUsdMinor).toBeNull();
    expect(pnl.outstandingUsdMinor).toBeNull();
    expect(pnl.unbilledUsdMinor).toBeNull();
    expect(pnl.budgetVarianceUsdMinor).toBeNull();
  });

  it('derives outstanding, unbilled and budget variance when they are entered', () => {
    const pnl = computeProjectPnl([inflow(600_000), outflow(450_000)], {
      contracted_revenue_minor: 1_000_000,
      invoiced_revenue_minor: 800_000,
      budget_expense_minor: 400_000,
    });

    expect(pnl.outstandingUsdMinor).toBe(200_000); // invoiced but not received
    expect(pnl.unbilledUsdMinor).toBe(200_000); // contracted but not invoiced
    expect(pnl.budgetVarianceUsdMinor).toBe(50_000); // overspent
  });

  it('breaks both sides down by category with shares that add to one', () => {
    const pnl = computeProjectPnl([
      inflow(600_000, { category: 'sponsorship' }),
      inflow(400_000, { category: 'tickets' }),
      outflow(300_000, { category: 'venue' }),
      outflow(200_000, { category: 'production' }),
    ]);

    expect(pnl.revenueByCategory.map((l) => l.category)).toEqual(['sponsorship', 'tickets']);
    expect(pnl.expenseByCategory[0]!.category).toBe('venue');

    const revShare = pnl.revenueByCategory.reduce((s, l) => s + l.shareOfSide, 0);
    const expShare = pnl.expenseByCategory.reduce((s, l) => s + l.shareOfSide, 0);
    expect(revShare).toBeCloseTo(1, 10);
    expect(expShare).toBeCloseTo(1, 10);
  });

  it('records the activity window from the rows it kept', () => {
    const pnl = computeProjectPnl([
      inflow(100, { txn_date: '2026-03-15' }),
      outflow(100, { txn_date: '2026-01-02' }),
      inflow(100, { txn_date: '2026-06-30' }),
    ]);
    expect(pnl.firstActivity).toBe('2026-01-02');
    expect(pnl.lastActivity).toBe('2026-06-30');
  });

  it('says which costs it cannot account for', () => {
    // Spec 12 wants allocated labour and software. Nothing can answer them yet,
    // and printing zero would flatter every margin on the page.
    const pnl = computeProjectPnl([inflow(100_000)]);
    expect(pnl.missingCostTypes).toContain('allocated_labour');
    expect(pnl.missingCostTypes).toContain('allocated_software');
  });

  it('converts a non-USD line at the supplied rate', () => {
    const vnd = txn({
      direction: 'inflow',
      currency: 'VND',
      amount_minor: 25_000_000,
      amount_usd_minor: null,
    });
    // 25,000,000 VND at 0.00004 is USD 1,000 — which is 100,000 in USD minor
    // units. The result is always minor units; reading it as dollars is how a
    // figure ends up a hundred times too small.
    const pnl = computeProjectPnl([vnd], {}, { USD: 1, VND: 0.00004 });
    expect(pnl.cashReceivedUsdMinor).toBe(100_000);
  });
});

describe('groupByProject', () => {
  const projects = [
    { id: 'p1', name: 'Website' },
    { id: 'p2', name: 'Summit' },
  ];

  it('keeps each project to its own rows', () => {
    const { rows } = groupByProject(projects, [
      inflow(100_000, {}) as never,
      { ...inflow(500_000), project_id: 'p1' },
      { ...outflow(200_000), project_id: 'p1' },
      { ...inflow(300_000), project_id: 'p2' },
    ]);

    expect(rows[0]!.pnl.grossProfitUsdMinor).toBe(300_000);
    expect(rows[1]!.pnl.cashReceivedUsdMinor).toBe(300_000);
  });

  it('returns unassigned rows instead of discarding them', () => {
    // Silently dropping overheads would let the sum of every project P&L
    // disagree with the company P&L, with nothing on screen to explain it.
    const { unassigned } = groupByProject(projects, [
      { ...outflow(90_000), project_id: null },
      { ...inflow(100_000), project_id: 'p1' },
    ]);
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]!.amount_minor).toBe(90_000);
  });

  it('gives a project with no transactions an empty P&L rather than skipping it', () => {
    const { rows } = groupByProject(projects, []);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.pnl.transactionCount).toBe(0);
    expect(rows[0]!.pnl.grossMarginRatio).toBeNull();
  });
});

describe('portfolioTotals', () => {
  const projects = [
    { id: 'p1', name: 'Website' },
    { id: 'p2', name: 'Summit' },
    { id: 'p3', name: 'Not started' },
  ];

  it('adds up the projects and counts the loss-making ones', () => {
    const { rows, unassigned } = groupByProject(projects, [
      { ...inflow(500_000), project_id: 'p1' },
      { ...outflow(200_000), project_id: 'p1' },
      { ...inflow(100_000), project_id: 'p2' },
      { ...outflow(400_000), project_id: 'p2' },
      { ...outflow(70_000), project_id: null },
    ]);

    const totals = portfolioTotals(rows, unassigned);
    expect(totals.cashReceivedUsdMinor).toBe(600_000);
    expect(totals.directExpenseUsdMinor).toBe(600_000);
    expect(totals.grossProfitUsdMinor).toBe(0);
    expect(totals.lossMakingCount).toBe(1); // p2 only
    expect(totals.unassignedCount).toBe(1);
  });

  it('does not call a project that has not started loss-making', () => {
    const { rows } = groupByProject(projects, []);
    expect(portfolioTotals(rows).lossMakingCount).toBe(0);
  });
});

describe('rollUpBy (spec §16)', () => {
  const projects = [
    { id: 'p1', business_unit_id: 'u1', business_unit: { name: 'Events' }, kind: 'event', service: 'Conferences' },
    { id: 'p2', business_unit_id: 'u1', business_unit: { name: 'Events' }, kind: 'event', service: 'Meetups' },
    { id: 'p3', business_unit_id: 'u2', business_unit: { name: 'Media' }, kind: 'project', service: null },
    { id: 'p4', business_unit_id: null, business_unit: null, kind: 'project', service: null },
  ];

  const ledger = [
    { ...inflow(500_000), project_id: 'p1' },
    { ...outflow(200_000), project_id: 'p1' },
    { ...inflow(100_000), project_id: 'p2' },
    { ...outflow(300_000), project_id: 'p2' },
    { ...inflow(400_000), project_id: 'p3' },
  ];

  it('adds the same numbers the individual P&Ls show', () => {
    // A roll-up computed independently would be a second implementation of the
    // same arithmetic, and nobody could tell which one was wrong when they
    // disagreed. This sums the P&Ls rather than re-reading the ledger.
    const { rows } = groupByProject(projects, ledger);
    const groups = rollUpBy(rows, 'business_unit');

    const events = groups.find((g) => g.label === 'Events')!;
    expect(events.cashReceivedUsdMinor).toBe(600_000);
    expect(events.directExpenseUsdMinor).toBe(500_000);
    expect(events.grossProfitUsdMinor).toBe(100_000);
    expect(events.projectCount).toBe(2);
    expect(events.lossMakingCount).toBe(1); // p2 only
  });

  it('keeps every group total adding back to the portfolio total', () => {
    const { rows, unassigned } = groupByProject(projects, ledger);
    const totals = portfolioTotals(rows, unassigned);

    for (const dimension of ['business_unit', 'service', 'client', 'kind', 'status'] as const) {
      const groups = rollUpBy(rows, dimension);
      const summed = groups.reduce((s, g) => s + g.grossProfitUsdMinor, 0);
      const counted = groups.reduce((s, g) => s + g.projectCount, 0);
      expect(summed, dimension).toBe(totals.grossProfitUsdMinor);
      expect(counted, dimension).toBe(totals.projectCount);
    }
  });

  it('gives projects with nothing in the dimension their own group', () => {
    // Dropping them would silently shrink the roll-up below the portfolio it
    // claims to summarise.
    const { rows } = groupByProject(projects, ledger);
    const groups = rollUpBy(rows, 'business_unit');
    const unset = groups.find((g) => g.label === 'Not set');
    expect(unset?.projectCount).toBe(1);
  });

  it('splits events from projects', () => {
    const { rows } = groupByProject(projects, ledger);
    const groups = rollUpBy(rows, 'kind');
    expect(groups.map((g) => g.label).sort()).toEqual(['Events', 'Projects']);
  });
});
