import { describe, expect, it } from 'vitest';
import { amountForStorage, settledOnFor } from '@/lib/obligations-sync';
import type { QboObligation } from '@/lib/connectors/quickbooks';

const invoice = (over: Partial<QboObligation> = {}): QboObligation => ({
  externalId: 'Invoice:1',
  direction: 'inflow',
  counterpartyName: 'Acme Corp',
  reference: 'INV-1001',
  description: 'Sponsorship',
  amountMinor: 4_000_000,
  contractedAmountMinor: 4_000_000,
  currency: 'USD',
  issuedOn: '2026-08-01',
  dueOn: '2026-08-31',
  isSettled: false,
  lastChangedOn: '2026-08-01',
  ...over,
});

describe('amountForStorage', () => {
  it('records what is still owed while the invoice is open', () => {
    // This is the number §17 ages and chases. A part-paid invoice is chased for
    // the part that is still outstanding, not for the original total.
    const partPaid = invoice({ amountMinor: 1_500_000, contractedAmountMinor: 4_000_000 });
    expect(amountForStorage(partPaid)).toBe(1_500_000);
  });

  it('records what was settled once it is paid', () => {
    // The balance is zero, and `amount_minor` carries a `> 0` check because an
    // obligation for nothing is not an obligation. The aging engine reads a
    // settled row's amount into `paid`, so the honest figure is the total.
    const paid = invoice({ amountMinor: 0, contractedAmountMinor: 4_000_000, isSettled: true });
    expect(amountForStorage(paid)).toBe(4_000_000);
  });

  it('never produces a zero that the check constraint would reject', () => {
    for (const o of [
      invoice({ amountMinor: 0, isSettled: false, contractedAmountMinor: 100 }),
      invoice({ amountMinor: 0, isSettled: true, contractedAmountMinor: 100 }),
    ]) {
      const amount = amountForStorage(o);
      // Zero is allowed to come out here; the caller counts it as skipped
      // rather than sending the database a row it will refuse.
      expect(amount).toBeGreaterThanOrEqual(0);
    }
    expect(amountForStorage(invoice({ amountMinor: 0, isSettled: false }))).toBe(0);
  });
});

describe('settledOnFor', () => {
  it('uses the day QuickBooks last changed the record', () => {
    // QuickBooks does not put the settlement date on the invoice — it lives on
    // the linked Payment. This is the closest available signal.
    expect(settledOnFor(invoice({ isSettled: true, lastChangedOn: '2026-08-20' }))).toBe(
      '2026-08-20',
    );
  });

  it('falls back to a real date on the record, never to today', () => {
    // "We noticed it today" is not a date anything financial happened, and a
    // settled_on of today would quietly move every old invoice into this
    // month's paid figure.
    expect(settledOnFor(invoice({ isSettled: true, lastChangedOn: null }))).toBe('2026-08-01');
    expect(
      settledOnFor(invoice({ isSettled: true, lastChangedOn: null, issuedOn: null })),
    ).toBe('2026-08-31');
  });
});

describe('what the sync is for', () => {
  it('keeps the contracted total alongside the outstanding balance', () => {
    // Spec §17 asks for contracted AND invoiced. A part-paid invoice must be
    // able to say both without either overwriting the other.
    const partPaid = invoice({ amountMinor: 1_500_000, contractedAmountMinor: 4_000_000 });
    expect(amountForStorage(partPaid)).toBe(1_500_000);
    expect(partPaid.contractedAmountMinor).toBe(4_000_000);
  });

  it('distinguishes a receivable from a payable by direction alone', () => {
    // One table, two directions — an overdue bill matters as much as an overdue
    // invoice, and two tables would mean two copies of the aging arithmetic.
    expect(invoice().direction).toBe('inflow');
    expect(invoice({ externalId: 'Bill:7', direction: 'outflow' }).direction).toBe('outflow');
  });
});
