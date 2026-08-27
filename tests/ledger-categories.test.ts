import { describe, expect, it } from 'vitest';
import { categorize } from '@/lib/categorize';

describe('QuickBooks ledger accounts', () => {
  it('classifies the sandbox chart of accounts', () => {
    const cases: Array<[string, string]> = [
      ['Automobile:Fuel', 'travel'],
      ['Automobile', 'travel'],
      ['Job Expenses:Job Materials:Plants and Soil', 'cost_of_delivery'],
      ['Job Expenses', 'cost_of_delivery'],
      ['Landscaping Services:Job Materials:Plants and Soil', 'cost_of_delivery'],
      ['Meals and Entertainment', 'meals_entertainment'],
      ['Legal & Professional Fees:Lawyer', 'professional_services'],
      ['Legal & Professional Fees:Accounting', 'professional_services'],
      ['Legal & Professional Fees:Bookkeeper', 'professional_services'],
      ['Maintenance and Repair', 'facilities'],
      ['Advertising', 'marketing'],
      ['Equipment Rental', 'equipment'],
      ['Office Expenses', 'office'],
    ];
    for (const [ledger, expected] of cases) {
      const guess = categorize({ ledgerAccount: ledger, direction: 'outflow' });
      expect(guess.category, `${ledger} -> ${guess.category} (rule ${guess.matchedRule})`).toBe(expected);
    }
  });

  it('lets the ledger outrank a meaningless bank memo', () => {
    // "Purchase 144" carries nothing. The ledger account is the only signal.
    const guess = categorize({
      description: 'Purchase 144',
      ledgerAccount: 'Automobile:Fuel',
      direction: 'outflow',
    });
    expect(guess.category).toBe('travel');
  });
});
