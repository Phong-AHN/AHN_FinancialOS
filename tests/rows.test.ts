import { describe, expect, it } from 'vitest';
import { rowsOrThrow } from '@/lib/supabase/rows';

/**
 * The guard against the most expensive shape of bug in this system: a query
 * error that renders as an empty result, and therefore as a confident zero.
 * It has happened three times — decisions 90, 95 and 96.
 */
describe('rowsOrThrow', () => {
  it('returns the rows when the read worked', () => {
    expect(rowsOrThrow({ data: [{ id: 'a' }], error: null }, 'accounts')).toEqual([{ id: 'a' }]);
  });

  it('treats a genuinely empty table as empty, not as a failure', () => {
    // Nothing on file is a legitimate answer. Only an error is not.
    expect(rowsOrThrow({ data: [], error: null }, 'accounts')).toEqual([]);
    expect(rowsOrThrow({ data: null, error: null }, 'accounts')).toEqual([]);
  });

  it('throws rather than handing back an empty list on error', () => {
    // The whole point. `(data ?? [])` turned a 400 into "0 alert rules exist",
    // and AHN was told alerting was dormant while 12 messages went to Slack.
    expect(() =>
      rowsOrThrow({ data: null, error: { message: 'column x does not exist' } }, 'alert rules'),
    ).toThrow(/alert rules/);
  });

  it('names what failed, because the message is read under pressure', () => {
    try {
      rowsOrThrow(
        { data: null, error: { message: 'permission denied', code: '42501' } },
        'transactions for the dashboard',
      );
      throw new Error('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('transactions for the dashboard');
      expect(message).toContain('permission denied');
      expect(message).toContain('42501');
    }
  });

  it('throws even when the error arrives beside rows', () => {
    // Postgrest can return a partial body with an error. Rows present is not
    // evidence the read succeeded.
    expect(() =>
      rowsOrThrow({ data: [{ id: 'a' }], error: { message: 'statement timeout' } }, 'accounts'),
    ).toThrow(/statement timeout/);
  });
});
