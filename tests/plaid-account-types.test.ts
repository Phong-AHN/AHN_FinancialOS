import { describe, expect, it } from 'vitest';
import { mapAccountType } from '@/lib/connectors/plaid';

/**
 * Locks the rule that a mortgage is not cash.
 *
 * Found live: a Plaid sandbox connection added a $56k mortgage, a $65k student
 * loan, a $23k auto loan, a $13k HELOC, a 401k and an IRA to the figure that
 * answers "how much cash do we have?" — $182,228 of debt and locked-up
 * holdings, with the loans counted POSITIVE because that is how Plaid reports
 * what is owed.
 */
describe('mapAccountType', () => {
  it('never counts borrowings as cash', () => {
    for (const subtype of ['mortgage', 'student', 'auto', 'line of credit', 'home equity']) {
      const m = mapAccountType('loan', subtype);
      expect(m.type, subtype).toBe('loan');
      expect(m.countsAsCash, subtype).toBe(false);
    }
  });

  it('never counts retirement or brokerage holdings as cash', () => {
    for (const [type, subtype] of [['investment', '401k'], ['investment', 'ira'], ['brokerage', null]] as const) {
      const m = mapAccountType(type, subtype);
      expect(m.type).toBe('investment');
      expect(m.countsAsCash).toBe(false);
    }
  });

  it('never counts a credit card as cash', () => {
    const m = mapAccountType('credit', 'credit card');
    expect(m.type).toBe('credit_card');
    expect(m.countsAsCash).toBe(false);
  });

  it('counts depository accounts as cash, labelled by subtype', () => {
    expect(mapAccountType('depository', 'checking')).toEqual({ type: 'checking', countsAsCash: true });
    expect(mapAccountType('depository', 'savings')).toEqual({ type: 'savings', countsAsCash: true });
    expect(mapAccountType('depository', 'cd')).toEqual({ type: 'savings', countsAsCash: true });
    expect(mapAccountType('depository', 'money market')).toEqual({ type: 'savings', countsAsCash: true });
    expect(mapAccountType('depository', 'hsa')).toEqual({ type: 'checking', countsAsCash: true });
  });

  it('does NOT count an unrecognised type as cash', () => {
    // Overstating what a company can spend is the dangerous direction. A balance
    // wrongly left out shows on the Accounts page, where a person can add it.
    for (const type of ['other', 'payroll', 'something-new']) {
      expect(mapAccountType(type, null).countsAsCash, type).toBe(false);
    }
  });
});
