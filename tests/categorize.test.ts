import { describe, expect, it } from 'vitest';
import { categorize, normalizeName } from '@/lib/categorize';
import { diffForAudit } from '@/lib/audit';

describe('categorize', () => {
  it('routes every vendor named in spec section 7 to software/subscription', () => {
    const vendors = [
      'Google Workspace', 'ClickUp', 'QuickBooks Online', 'Beehiiv', 'ManyChat',
      'Envato Elements', 'DigitalOcean', 'Spotify', 'ElevenLabs', 'GoDaddy', 'SmugMug',
    ];
    for (const vendor of vendors) {
      const guess = categorize({ counterpartyName: vendor, direction: 'outflow' });
      expect(guess.category, vendor).toBe('software');
      expect(guess.isSubscription, vendor).toBe(true);
      expect(guess.isRecurring, vendor).toBe(true);
    }
  });

  it('recognises the three payroll routes separately', () => {
    expect(categorize({ description: 'VEEM transfer to Manila', direction: 'outflow' }).subcategory)
      .toBe('ph_payroll_veem');
    expect(categorize({ counterpartyName: 'Gusto', direction: 'outflow' }).subcategory)
      .toBe('us_payroll');
    expect(categorize({ description: 'Chuyen luong nhan vien', direction: 'outflow' }).subcategory)
      .toBe('payroll');
  });

  it('detects internal transfers so burn and revenue skip them', () => {
    const guess = categorize({ description: 'Internal transfer to savings', direction: 'outflow' });
    expect(guess.isInternalTransfer).toBe(true);
    expect(guess.counterpartyType).toBe('internal');
  });

  it('only applies inflow-only rules to inflows', () => {
    // "Sponsorship fee" paid OUT is marketing spend, not revenue.
    expect(categorize({ description: 'Sponsorship fee', direction: 'inflow' }).category).toBe('revenue');
    expect(categorize({ description: 'Sponsorship fee', direction: 'outflow' }).category).toBe('marketing');
  });

  it('leaves an unrecognised outflow uncategorised rather than guessing', () => {
    // An unreviewed wrong category is worse than a blank one - it looks settled.
    const guess = categorize({ description: 'ACH DEBIT 8827341 REF#00921', direction: 'outflow' });
    expect(guess.category).toBe('uncategorized');
    expect(guess.matchedRule).toBeNull();
  });

  it('reports which rule fired, so the guess can be explained', () => {
    expect(categorize({ counterpartyName: 'VEEM', direction: 'outflow' }).matchedRule).toBe('payroll-veem-ph');
  });
});

describe('normalizeName', () => {
  it('collapses the noisy shapes a vendor name arrives in', () => {
    expect(normalizeName('GOOGLE *WORKSPACE_AH')).toBe(normalizeName('Google Workspace AH'));
    expect(normalizeName('Ledgerly CPA, LLC')).toBe('ledgerly cpa');
  });

  it('never returns an empty key', () => {
    expect(normalizeName('***')).toBe('unknown');
    expect(normalizeName(null)).toBe('unknown');
  });
});

describe('diffForAudit', () => {
  it('records one entry per changed field', () => {
    const entries = diffForAudit(
      'transactions',
      'txn-1',
      { category: 'uncategorized', notes: null, is_subscription: false },
      { category: 'software', notes: 'Annual plan', is_subscription: true },
      'Reclassified during monthly close',
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      field: 'category',
      old_value: 'uncategorized',
      new_value: 'software',
      reason: 'Reclassified during monthly close',
    });
  });

  it('writes nothing when a form is saved unchanged', () => {
    const entries = diffForAudit(
      'transactions',
      'txn-1',
      { category: 'software', notes: 'x' },
      { category: 'software', notes: 'x' },
    );
    expect(entries).toHaveLength(0);
  });

  it('treats null and empty as distinct, since one is a real edit', () => {
    const entries = diffForAudit('transactions', 'txn-1', { notes: null }, { notes: '' });
    expect(entries).toHaveLength(1);
  });
});

describe('retainers: who is paying whom', () => {
  it('treats a client retainer ARRIVING as revenue', () => {
    // Found on live Stripe data: "Client retainer — Lotus Beauty Labs" was
    // filed under professional_services/legal, because the legal rule matched
    // the bare word "retainer" and was not scoped to outflows. It is a client
    // paying AHN.
    const guess = categorize({
      description: 'Client retainer — Lotus Beauty Labs, August',
      direction: 'inflow',
    });
    expect(guess.category).toBe('revenue');
    expect(guess.counterpartyType).toBe('customer');
  });

  it('still treats a legal retainer GOING OUT as legal spend', () => {
    const guess = categorize({
      description: 'Legal retainer — contracts review',
      direction: 'outflow',
    });
    expect(guess.category).toBe('professional_services');
    expect(guess.subcategory).toBe('legal');
  });

  it('keeps the rest of the legal rule working', () => {
    for (const d of ['Legal fees', 'Attorney fees', 'Law firm invoice', 'Outside counsel']) {
      expect(categorize({ description: d, direction: 'outflow' }).category, d).toBe(
        'professional_services',
      );
    }
  });

  it('leaves a bare firm name uncategorised rather than guessing', () => {
    // "Whitfield & Cho LLP" names a firm and says nothing about what the money
    // was for. Guessing from a suffix would be wrong as often as right; the row
    // belongs in the review queue, or gets its category from the QuickBooks
    // ledger account, which is authoritative.
    expect(categorize({ description: 'Whitfield & Cho LLP', direction: 'outflow' }).category).toBe(
      'uncategorized',
    );
    expect(
      categorize({
        description: 'Whitfield & Cho LLP',
        ledgerAccount: 'Legal & Professional Fees:Lawyer',
        direction: 'outflow',
      }).category,
    ).toBe('professional_services');
  });
});
