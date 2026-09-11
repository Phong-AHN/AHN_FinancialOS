import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CDC_OVERLAP_MS,
  CDC_RESPONSE_CAP,
  UNAVAILABLE_RECHECK_MS,
  fetchQboChanges,
  fetchQboTransactions,
  forEntity,
  nextUnavailable,
  planQboSync,
} from '@/lib/connectors/quickbooks';
import { ProviderAuthError, classifyIntuitFailure, withRetry } from '@/lib/connectors/retry';

/**
 * Change Data Capture, and QuickBooks editions that do not all have the same
 * features.
 *
 * The response fixtures here are the shape the LIVE sandbox returned when
 * `tests/cdc.integration.test.ts` asked it — `CDCResponse[].QueryResponse[]`,
 * each block keyed by entity with `startPosition` and `maxResults` beside it
 * and no `totalCount`. Not the shape a blog post described.
 */

process.env.QBO_CLIENT_ID ??= 'test-client';
process.env.QBO_CLIENT_SECRET ??= 'test-secret';

afterEach(() => vi.unstubAllGlobals());

const NOW = new Date('2026-09-11T09:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

describe('planQboSync', () => {
  it('uses the full query path on a first sync', () => {
    const plan = planQboSync({ lastSyncedAt: null, unavailable: {}, now: NOW });
    expect(plan.path).toBe('query');
  });

  it('uses CDC for a recent incremental sync, overlapping the last one', () => {
    const plan = planQboSync({ lastSyncedAt: hoursAgo(1), unavailable: {}, now: NOW });
    expect(plan.path).toBe('cdc');
    // Overlap, because last_synced_at is stamped when a sync FINISHES.
    expect(plan.changedSince!.getTime()).toBe(new Date(hoursAgo(1)).getTime() - CDC_OVERLAP_MS);
  });

  it('falls back to the query path outside CDC’s 30-day window', () => {
    expect(planQboSync({ lastSyncedAt: daysAgo(28), unavailable: {}, now: NOW }).path).toBe('cdc');
    expect(planQboSync({ lastSyncedAt: daysAgo(31), unavailable: {}, now: NOW }).path).toBe('query');
  });

  it('skips an entity found missing less than a day ago', () => {
    const plan = planQboSync({
      lastSyncedAt: hoursAgo(1),
      unavailable: { Bill: hoursAgo(3), BillPayment: hoursAgo(3) },
      now: NOW,
    });
    expect(plan.path).toBe('cdc');
    expect(plan.skip.sort()).toEqual(['Bill', 'BillPayment']);
  });

  it('re-checks a missing entity once a day, on the query path', () => {
    // The customer may have upgraded. The query path is used so that, if they
    // did, the entity arrives with its history rather than just from now on.
    const plan = planQboSync({
      lastSyncedAt: hoursAgo(1),
      unavailable: { Bill: new Date(NOW.getTime() - UNAVAILABLE_RECHECK_MS - 1000).toISOString() },
      now: NOW,
    });
    expect(plan.path).toBe('query');
    expect(plan.skip).toEqual([]);
    expect(plan.reason).toMatch(/Bill/);
  });

  it('treats a garbled last-sync timestamp as needing the safe path', () => {
    expect(planQboSync({ lastSyncedAt: 'not a date', unavailable: {}, now: NOW }).path).toBe('query');
  });
});

describe('nextUnavailable — noticing a customer who changed edition', () => {
  it('keeps the original mark for something not asked about this time', () => {
    const mark = hoursAgo(5);
    expect(nextUnavailable({ Bill: mark }, ['Bill'], [], NOW)).toEqual({ Bill: mark });
  });

  it('marks what was refused this time', () => {
    expect(nextUnavailable({}, [], ['Bill'], NOW)).toEqual({ Bill: NOW.toISOString() });
  });

  it('forgets an entity the moment it is answered — the customer upgraded', () => {
    // Asked (not skipped), and not refused: they have it now.
    expect(nextUnavailable({ Bill: daysAgo(2) }, [], [], NOW)).toEqual({});
  });
});

describe('an edition that lacks a feature', () => {
  const simpleStartRefusal = () =>
    classifyIntuitFailure(
      400,
      JSON.stringify({
        Fault: {
          Error: [
            {
              Message: 'Feature Not Supported Error',
              Detail: 'This feature is not included in your QuickBooks Online Simple Start subscription.',
              code: '5030',
            },
          ],
          type: 'ValidationFault',
        },
      }),
    );

  it('is classified as unavailable — not a fault, not a reconnect', () => {
    const err = simpleStartRefusal();
    expect(err.kind).toBe('unavailable');
    expect(err.needsReconnect).toBe(false);
  });

  it('is not retried', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw simpleStartRefusal();
        },
        { sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    expect(calls).toBe(1);
  });

  it('forEntity skips it and records it, instead of failing', async () => {
    const unavailable: string[] = [];
    const rows = await forEntity('Bill', unavailable, async () => {
      throw simpleStartRefusal();
    });
    expect(rows).toEqual([]);
    expect(unavailable).toEqual(['Bill']);
  });

  it('forEntity still lets an auth failure through — that one needs a person', async () => {
    await expect(
      forEntity('Bill', [], async () => {
        throw classifyIntuitFailure(400, 'invalid_grant');
      }),
    ).rejects.toMatchObject({ kind: 'reconnect' });
  });

  it('a Simple Start company still gets its purchases, deposits and payments', async () => {
    // THE BUG THIS FIXES. Before per-entity isolation, BillPayment's refusal
    // escaped and failed the whole sync — so a Simple Start customer got
    // nothing at all, over data they never had.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const statement = decodeURIComponent(new URL(url).searchParams.get('query') ?? '');
        if (statement.includes('from BillPayment')) {
          return new Response(
            '{"Fault":{"Error":[{"Message":"Feature Not Supported Error","code":"5030"}]}}',
            { status: 400 },
          );
        }
        const entity = statement.match(/from (\w+)/)![1]!;
        return new Response(
          JSON.stringify({
            QueryResponse: { [entity]: [{ Id: '1', TotalAmt: 10, TxnDate: '2026-09-01' }] },
          }),
          { status: 200 },
        );
      }),
    );

    const unavailable: string[] = [];
    const txns = await fetchQboTransactions({
      accessToken: 't',
      realmId: 'r',
      since: '2026-08-01',
      accountIdFor: () => 'acct',
      unavailable,
    });

    expect(unavailable).toEqual(['BillPayment']);
    expect(txns.map((t) => t.external_txn_id).sort()).toEqual([
      'Deposit:1',
      'Payment:1',
      'Purchase:1',
    ]);
  });

  it('does not even ask for an entity already known to be missing', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const statement = decodeURIComponent(new URL(url).searchParams.get('query') ?? '');
        asked.push(statement.match(/from (\w+)/)![1]!);
        return new Response('{"QueryResponse":{}}', { status: 200 });
      }),
    );
    await fetchQboTransactions({
      accessToken: 't',
      realmId: 'r',
      since: '2026-08-01',
      accountIdFor: () => 'acct',
      skip: ['BillPayment'],
    });
    expect(asked).not.toContain('BillPayment');
  });
});

describe('fetchQboChanges', () => {
  /** The shape the live sandbox actually returned. */
  const liveShaped = (blocks: Array<Record<string, unknown>>) =>
    new Response(
      JSON.stringify({
        CDCResponse: [{ QueryResponse: blocks }],
        time: '2026-09-11T02:17:33.021-07:00',
      }),
      { status: 200 },
    );

  it('separates changed rows from deleted ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        liveShaped([
          {
            Purchase: [
              { Id: '101', TotalAmt: 25, TxnDate: '2026-09-10' },
              { domain: 'QBO', status: 'Deleted', Id: '102', MetaData: { LastUpdatedTime: '2026-09-10T10:00:00-07:00' } },
            ],
            startPosition: 1,
            maxResults: 2,
          },
          { Invoice: [{ Id: '7', TotalAmt: 100 }], startPosition: 1, maxResults: 1 },
        ]),
      ),
    );

    const out = await fetchQboChanges('t', 'r', ['Purchase', 'Invoice'], new Date(NOW));
    expect(out.changed.Purchase?.map((r) => r.Id)).toEqual(['101']);
    expect(out.deleted.Purchase).toEqual(['102']);
    expect(out.changed.Invoice?.map((r) => r.Id)).toEqual(['7']);
    expect(out.size).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it('encodes the + in the UTC offset, so the timestamp is not read as a space', async () => {
    const spy = vi.fn(async () => liveShaped([]));
    vi.stubGlobal('fetch', spy);
    await fetchQboChanges('t', 'r', ['Purchase'], new Date('2026-09-10T08:00:00Z'));

    const url = String((spy.mock.calls[0] as unknown as [string])[0]);
    expect(url).toContain('changedSince=2026-09-10T08%3A00%3A00%2B00%3A00');
    expect(url).not.toMatch(/changedSince=[^&]*\+/);
  });

  it('reads a fault that arrives inside a 200', async () => {
    // Reading only the status would take "your subscription does not include
    // Bill" as "nothing changed".
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            CDCResponse: [{ Fault: { Error: [{ Message: 'Feature Not Supported Error', code: '5030' }] } }],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(fetchQboChanges('t', 'r', ['Bill'], new Date(NOW))).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('flags a response at the size cap as possibly cut off', async () => {
    // Trusting a truncated change set is how rows go missing without anybody
    // being told. The caller falls back to the full query path.
    const rows = Array.from({ length: CDC_RESPONSE_CAP }, (_, i) => ({ Id: String(i), TotalAmt: 1 }));
    vi.stubGlobal('fetch', vi.fn(async () => liveShaped([{ Purchase: rows, startPosition: 1, maxResults: rows.length }])));
    const out = await fetchQboChanges('t', 'r', ['Purchase'], new Date(NOW));
    expect(out.truncated).toBe(true);
  });

  it('flags a block that says more exist than it carried', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => liveShaped([{ Purchase: [{ Id: '1', TotalAmt: 1 }], totalCount: 40 }])),
    );
    expect((await fetchQboChanges('t', 'r', ['Purchase'], new Date(NOW))).truncated).toBe(true);
  });

  it('asks for every entity in one request', async () => {
    const spy = vi.fn(async () => liveShaped([]));
    vi.stubGlobal('fetch', spy);
    await fetchQboChanges('t', 'r', ['Purchase', 'Deposit', 'Invoice'], new Date(NOW));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String((spy.mock.calls[0] as unknown as [string])[0])).toContain(
      'entities=Purchase%2CDeposit%2CInvoice',
    );
  });
});
