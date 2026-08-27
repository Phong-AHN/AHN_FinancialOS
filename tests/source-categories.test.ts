import { describe, expect, it } from 'vitest';
import { categorize } from '@/lib/categorize';

describe('the source system as a categorisation signal', () => {
  it('classifies a VEEM export as Philippines payroll from the file alone', () => {
    // A VEEM row names the recipient and nothing else. "Jomar Reyes" says
    // nothing about what the payment was for; the file being a VEEM export says
    // it is Philippines payroll with certainty no description could match.
    const guess = categorize({
      description: 'Jomar Reyes',
      counterpartyName: 'Jomar Reyes',
      sourceSystem: 'csv_veem',
      direction: 'outflow',
    });
    expect(guess.category).toBe('people');
    expect(guess.subcategory).toBe('ph_payroll_veem');
    expect(guess.counterpartyType).toBe('employee');
    expect(guess.isRecurring).toBe(true);
  });

  it('classifies a payroll export as payroll', () => {
    const guess = categorize({
      description: 'Dan Nguyen',
      sourceSystem: 'csv_payroll',
      direction: 'outflow',
    });
    expect(guess.category).toBe('people');
    expect(guess.subcategory).toBe('payroll');
  });

  it('does NOT treat money arriving on a payroll rail as salary', () => {
    // An inflow on a payroll rail is a refund or a top-up, never a wage.
    const guess = categorize({
      description: 'Funding received from Chase',
      sourceSystem: 'csv_veem',
      direction: 'inflow',
    });
    expect(guess.category).not.toBe('people');
  });

  it('leaves general-purpose sources to the pattern rules', () => {
    // A bank feed carries every kind of spend, so the source says nothing.
    for (const source of ['plaid', 'quickbooks', 'csv_vn_bank', 'manual'] as const) {
      const guess = categorize({
        description: 'Google Workspace monthly',
        sourceSystem: source,
        direction: 'outflow',
      });
      expect(guess.category, source).toBe('software');
    }
  });

  it('still works when no source is supplied', () => {
    expect(categorize({ description: 'Gusto payroll', direction: 'outflow' }).category).toBe('people');
  });
});
