import { describe, expect, it } from 'vitest';
import { categorize } from '@/lib/categorize';

/**
 * What the first production Stripe sync actually contained.
 *
 * 418 real rows arrived: 189 charges for event seats, 189 processing fees, 38
 * payouts and 2 refunds. The charges landed in `revenue` with no subcategory —
 * "money came in, we don't know from what" — and the refunds matched no rule at
 * all, sitting in the uncategorised queue while Stripe had labelled them
 * plainly. These are the descriptions, verbatim.
 */

const stripe = (description: string, direction: 'inflow' | 'outflow', providerType?: string) =>
  categorize({ description, direction, sourceSystem: 'stripe', providerType });

describe('what Stripe itself says the row is', () => {
  it('books a refund as revenue going back out, not as an expense', () => {
    const guess = stripe('REFUND FOR CHARGE (Access Conference 2026)', 'outflow', 'refund');
    expect(guess).toMatchObject({ category: 'revenue', subcategory: 'refund' });
    // The mistake this replaces: an unrecognised outflow became `uncategorized`.
    expect(guess.category).not.toBe('uncategorized');
  });

  it('treats a payout as our own money moving, never as revenue', () => {
    const guess = stripe('STRIPE PAYOUT', 'outflow', 'payout');
    expect(guess).toMatchObject({
      category: 'transfer',
      subcategory: 'processor_payout',
      isInternalTransfer: true,
    });
  });

  it('books a dispute as revenue reversing', () => {
    expect(stripe('Chargeback', 'outflow', 'adjustment')).toMatchObject({
      category: 'revenue',
      subcategory: 'chargeback',
    });
  });

  it('books a processing fee as a bank fee', () => {
    expect(stripe('Stripe fee', 'outflow', 'stripe_fee')).toMatchObject({
      category: 'bank_fees',
      subcategory: 'processing',
    });
  });

  it('leaves a charge to the description — the type says paid, not what for', () => {
    expect(stripe('Asian Heritage Launch 2026 | Melbourne', 'inflow', 'charge').subcategory).toBe('tickets');
  });
});

describe('event seats, named as events rather than as tickets', () => {
  it.each([
    'Asian Heritage Launch 2026 | Melbourne',
    'Asian Heritage Launch 2026 | Vancouver',
    "HER Legacy: A Women's Leadership Luncheon | Las Vegas",
    'Access Conference 2026',
    'AHN Summit 2027',
    'Founders Mixer | San Francisco',
    'Growth Workshop — Seattle',
  ])('%s is ticket revenue', (description) => {
    expect(stripe(description, 'inflow', 'charge')).toMatchObject({
      category: 'revenue',
      subcategory: 'tickets',
      counterpartyType: 'customer',
    });
  });

  it('does not turn an outgoing payment for a conference into revenue', () => {
    const guess = stripe('Conference venue deposit', 'outflow');
    expect(guess.category).not.toBe('revenue');
  });
});

describe('consulting revenue, the line Stripe invoicing is opening', () => {
  it.each([
    'Management consulting — September 2026',
    'Advisory retainer',
    'Professional services engagement',
  ])('%s is consulting revenue', (description) => {
    expect(stripe(description, 'inflow', 'charge').category).toBe('revenue');
    expect(['consulting', 'client_services']).toContain(stripe(description, 'inflow', 'charge').subcategory);
  });
});
