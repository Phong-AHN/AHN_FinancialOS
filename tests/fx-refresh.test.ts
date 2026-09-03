import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * `refreshRates` decides what to write, what to leave alone and what to refuse.
 * That decision is the part with teeth, and against the live database it is
 * mostly unreachable: a rate row is dated, so the only way to exercise the
 * "write" branch for real is to wait for a day nobody has touched by hand.
 *
 * So the decision runs here against a stub, with the plausibility guard left
 * REAL — mocking that would leave the one rule that protects every USD figure
 * in the company covered by nothing.
 */
vi.mock('@/lib/fx-feed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fx-feed')>();
  return { ...actual, fetchQuotes: vi.fn() };
});

import { fetchQuotes, type FeedQuote } from '@/lib/fx-feed';
import { refreshRates } from '@/lib/fx';

const asMock = fetchQuotes as unknown as ReturnType<typeof vi.fn>;

interface Row {
  base_currency: string;
  quote_currency: string;
  rate: number;
  as_of: string;
  source: string;
}

/** Just enough Supabase to answer the three queries `refreshRates` makes. */
function fakeDb(rows: Row[], opts: { upsertError?: string } = {}) {
  const upserts: Row[] = [];

  const from = (table: string) => {
    const eqs: Array<[string, unknown]> = [];
    const ltes: Array<[string, unknown]> = [];

    const matched = () => {
      if (table === 'accounts') return [{ currency: 'VND' }, { currency: 'USD' }];
      return rows
        .filter((r) => eqs.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v))
        .filter((r) => ltes.every(([c, v]) => String((r as unknown as Record<string, unknown>)[c]) <= String(v)))
        .sort((a, b) => b.as_of.localeCompare(a.as_of));
    };

    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => (eqs.push([c, v]), api),
      lte: (c: string, v: unknown) => (ltes.push([c, v]), api),
      neq: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      upsert: async (row: Row) => {
        if (opts.upsertError) return { error: { message: opts.upsertError } };
        upserts.push(row);
        return { error: null };
      },
      // `select()` is also awaited directly, for the accounts query.
      then: (resolve: (v: { data: unknown; error: null }) => void) =>
        resolve({ data: matched(), error: null }),
    };
    return api;
  };

  return { db: { from } as unknown as SupabaseClient, upserts };
}

const quote = (over: Partial<FeedQuote> = {}): FeedQuote => ({
  currency: 'VND',
  usdPerUnit: 1 / 26_260,
  asOf: '2026-09-02',
  source: 'vietcombank:sell',
  ...over,
});

const row = (over: Partial<Row> = {}): Row => ({
  base_currency: 'VND',
  quote_currency: 'USD',
  rate: 0.000038,
  as_of: '2026-09-01',
  source: 'seed',
  ...over,
});

beforeEach(() => asMock.mockReset());

describe('refreshRates', () => {
  it('writes a fetched rate when no one has set one for that day', async () => {
    asMock.mockResolvedValue({ quotes: [quote()], problems: [] });
    const { db, upserts } = fakeDb([row()]);

    const result = await refreshRates(db, { asOf: '2026-09-02' });

    expect(result.written).toHaveLength(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.as_of).toBe('2026-09-02');
    expect(upserts[0]!.source).toBe('vietcombank:sell');
    expect(upserts[0]!.rate).toBeCloseTo(1 / 26_260, 12);
  });

  it('leaves a rate a person set for that day exactly where it is', async () => {
    // The rule that matters most. If the CFO typed the rate a deal actually
    // closed at, or the rate an auditor agreed, a robot must not quietly
    // replace it the next morning.
    asMock.mockResolvedValue({ quotes: [quote()], problems: [] });
    const { db, upserts } = fakeDb([
      row({ as_of: '2026-09-02', rate: 0.0000383142, source: 'manual:cfo@example.com' }),
    ]);

    const result = await refreshRates(db, { asOf: '2026-09-02' });

    expect(result.keptManual).toEqual(['VND']);
    expect(result.written).toEqual([]);
    expect(upserts).toEqual([]);
  });

  it('overwrites its own earlier rate for the same day', async () => {
    // A feed row is not sacred the way a person's is: running twice in a day
    // should land on the bank's latest publication, not the morning's.
    asMock.mockResolvedValue({ quotes: [quote()], problems: [] });
    const { db, upserts } = fakeDb([
      row({ as_of: '2026-09-02', rate: 0.0000381, source: 'vietcombank:sell' }),
    ]);

    const result = await refreshRates(db, { asOf: '2026-09-02' });
    expect(result.written).toHaveLength(1);
    expect(upserts).toHaveLength(1);
  });

  it('reports an identical rate as unchanged rather than rewriting it', async () => {
    asMock.mockResolvedValue({ quotes: [quote()], problems: [] });
    const { db, upserts } = fakeDb([
      row({ as_of: '2026-09-02', rate: 1 / 26_260, source: 'vietcombank:sell' }),
    ]);

    const result = await refreshRates(db, { asOf: '2026-09-02' });
    expect(result.unchanged).toEqual(['VND']);
    expect(upserts).toEqual([]);
  });

  it('refuses an inverted rate and keeps yesterday standing', async () => {
    // 26,260 USD per dong. Writing it would multiply every VND balance in the
    // company by seven hundred million.
    asMock.mockResolvedValue({ quotes: [quote({ usdPerUnit: 26_260 })], problems: [] });
    const { db, upserts } = fakeDb([row()]);

    const result = await refreshRates(db, { asOf: '2026-09-02' });

    expect(result.written).toEqual([]);
    expect(upserts).toEqual([]);
    expect(result.refused[0]!.currency).toBe('VND');
    expect(result.refused[0]!.reason).toContain('inverted');
  });

  it('sizes the plausibility allowance against the last rate on file, not against yesterday', async () => {
    // The feed has been down since 3 August and the dong has drifted 8%. That
    // is a fortnight of ordinary movement, not a broken parse, so it is stored.
    asMock.mockResolvedValue({ quotes: [quote({ usdPerUnit: 0.000038 * 1.08 })], problems: [] });
    const { db, upserts } = fakeDb([row({ as_of: '2026-08-03' })]);

    const result = await refreshRates(db, { asOf: '2026-09-02' });
    expect(result.refused).toEqual([]);
    expect(upserts).toHaveLength(1);
  });

  it('carries a storage failure back as a problem instead of claiming success', async () => {
    asMock.mockResolvedValue({ quotes: [quote()], problems: [] });
    const { db } = fakeDb([row()], { upsertError: 'permission denied' });

    const result = await refreshRates(db, { asOf: '2026-09-02' });
    expect(result.written).toEqual([]);
    expect(result.problems[0]).toContain('permission denied');
  });

  it('passes the feed only the currencies the company holds', async () => {
    asMock.mockResolvedValue({ quotes: [], problems: [] });
    const { db } = fakeDb([]);

    await refreshRates(db, { asOf: '2026-09-02' });

    // Accounts hold VND and USD; USD is never fetched because one dollar is one
    // dollar, and it is seeded.
    expect(asMock.mock.calls[0]![0]).toEqual(['VND']);
  });

  it('surfaces a source outage rather than swallowing it', async () => {
    asMock.mockResolvedValue({ quotes: [], problems: ['portal.vietcombank.com.vn answered 503'] });
    const { db } = fakeDb([row()]);

    const result = await refreshRates(db, { asOf: '2026-09-02' });
    expect(result.problems).toContain('portal.vietcombank.com.vn answered 503');
    expect(result.written).toEqual([]);
  });
});
