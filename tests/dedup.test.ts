import { describe, expect, it } from 'vitest';
import { descriptionSimilarity, findDuplicates } from '@/lib/dedup';
import type { Transaction } from '@/lib/types';

type Candidate = Parameters<typeof findDuplicates>[0][number];

let n = 0;
function row(overrides: Partial<Candidate> = {}): Candidate {
  n++;
  return {
    id: `t${n}`,
    account_id: 'acc-1',
    txn_date: '2026-08-10',
    amount_minor: 875_000,
    currency: 'USD',
    direction: 'inflow',
    description: 'Pacific Rim Ventures payment',
    source_system: 'plaid',
    reconciliation_status: 'unreconciled',
    created_at: `2026-08-10T00:00:0${n % 10}Z`,
    ...overrides,
  } as Candidate;
}

describe('findDuplicates', () => {
  it('matches the same payment arriving from the bank feed and the ledger', () => {
    const matches = findDuplicates([
      row({ id: 'qbo-1', source_system: 'quickbooks' }),
      row({ id: 'plaid-1', source_system: 'plaid' }),
    ]);

    expect(matches).toHaveLength(1);
    // QuickBooks is the accounting source of truth (spec 29), so it survives.
    expect(matches[0]!.keepId).toBe('qbo-1');
    expect(matches[0]!.flagId).toBe('plaid-1');
  });

  it('tolerates a posting-date gap inside the window', () => {
    const matches = findDuplicates([
      row({ id: 'qbo-1', source_system: 'quickbooks', txn_date: '2026-08-10' }),
      row({ id: 'plaid-1', source_system: 'plaid', txn_date: '2026-08-12' }),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.dayGap).toBe(2);
  });

  it('does not match beyond the window', () => {
    const matches = findDuplicates([
      row({ id: 'qbo-1', source_system: 'quickbooks', txn_date: '2026-08-10' }),
      row({ id: 'plaid-1', source_system: 'plaid', txn_date: '2026-08-20' }),
    ]);
    expect(matches).toHaveLength(0);
  });

  it('never matches two rows from the same source', () => {
    // Two genuine identical charges on one card in one day are real. The DB key
    // already prevents true duplicates within a source.
    const matches = findDuplicates([
      row({ id: 'a', source_system: 'plaid', amount_minor: 500 }),
      row({ id: 'b', source_system: 'plaid', amount_minor: 500 }),
    ]);
    expect(matches).toHaveLength(0);
  });

  it('does not match across different amounts, directions or currencies', () => {
    expect(
      findDuplicates([
        row({ id: 'a', source_system: 'quickbooks', amount_minor: 100 }),
        row({ id: 'b', source_system: 'plaid', amount_minor: 101 }),
      ]),
    ).toHaveLength(0);

    expect(
      findDuplicates([
        row({ id: 'a', source_system: 'quickbooks', direction: 'inflow' }),
        row({ id: 'b', source_system: 'plaid', direction: 'outflow' }),
      ]),
    ).toHaveLength(0);

    expect(
      findDuplicates([
        row({ id: 'a', source_system: 'quickbooks', currency: 'USD' }),
        row({ id: 'b', source_system: 'csv_vn_bank', currency: 'VND' }),
      ]),
    ).toHaveLength(0);
  });

  it('skips zero-amount rows, which would otherwise match everything', () => {
    const matches = findDuplicates([
      row({ id: 'a', source_system: 'quickbooks', amount_minor: 0 }),
      row({ id: 'b', source_system: 'plaid', amount_minor: 0 }),
    ]);
    expect(matches).toHaveLength(0);
  });

  it('leaves a human decision alone', () => {
    const matches = findDuplicates([
      row({ id: 'a', source_system: 'quickbooks' }),
      row({ id: 'b', source_system: 'plaid', reconciliation_status: 'duplicate_ignored' }),
    ]);
    expect(matches).toHaveLength(0);
  });

  it('flags each row at most once', () => {
    const matches = findDuplicates([
      row({ id: 'qbo', source_system: 'quickbooks' }),
      row({ id: 'plaid', source_system: 'plaid' }),
      row({ id: 'stripe', source_system: 'stripe' }),
    ]);
    const flagged = matches.map((m) => m.flagId);
    expect(new Set(flagged).size).toBe(flagged.length);
  });

  it('scores a same-day match with a similar description higher', () => {
    const strong = findDuplicates([
      row({ id: 'a', source_system: 'quickbooks', description: 'Ledgerly CPA monthly close' }),
      row({ id: 'b', source_system: 'plaid', description: 'LEDGERLY CPA monthly close' }),
    ]);
    const weak = findDuplicates([
      row({ id: 'c', source_system: 'quickbooks', txn_date: '2026-08-10', description: 'Ledgerly CPA' }),
      row({ id: 'd', source_system: 'plaid', txn_date: '2026-08-12', description: 'Unrelated vendor xyz' }),
    ]);
    expect(strong[0]!.score).toBeGreaterThan(weak[0]!.score);
  });
});

describe('descriptionSimilarity', () => {
  it('ignores noise words and payment boilerplate', () => {
    expect(descriptionSimilarity('ACH PAYMENT TO Ledgerly', 'Ledgerly')).toBeGreaterThan(0.9);
  });

  it('returns zero for unrelated text', () => {
    expect(descriptionSimilarity('Vietnam Airlines', 'Google Workspace')).toBe(0);
  });

  it('handles missing descriptions', () => {
    expect(descriptionSimilarity(null, 'anything')).toBe(0);
  });
});

describe('re-sweeping settled pairs', () => {
  it('reports the flag side current status, so a repeat sweep is not an error', () => {
    // The sweep runs every ten minutes and will keep re-finding every pair it
    // has already flagged. Without this the cron log fills with the same
    // "failures" forever and a real failure stops being visible.
    const matches = findDuplicates([
      row({ id: 'qbo', source_system: 'quickbooks' }),
      row({ id: 'plaid', source_system: 'plaid', reconciliation_status: 'possible_duplicate' }),
    ]);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.flagId).toBe('plaid');
    expect(matches[0]!.flagStatus).toBe('possible_duplicate');
  });

  it('reports unreconciled for a pair seen for the first time', () => {
    const matches = findDuplicates([
      row({ id: 'qbo', source_system: 'quickbooks' }),
      row({ id: 'plaid', source_system: 'plaid' }),
    ]);
    expect(matches[0]!.flagStatus).toBe('unreconciled');
  });

  it('still finds a pair dated well outside a short window', () => {
    // The first sync of any source backfills six months at once. A sweep window
    // shorter than that backfill would never reach those pairs, and they would
    // double-count cash permanently with nothing to trigger a re-check.
    const matches = findDuplicates([
      row({ id: 'qbo', source_system: 'quickbooks', txn_date: '2026-02-10' }),
      row({ id: 'plaid', source_system: 'plaid', txn_date: '2026-02-10' }),
    ]);
    expect(matches).toHaveLength(1);
  });
});
