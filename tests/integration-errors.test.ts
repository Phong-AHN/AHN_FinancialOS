import { describe, expect, it, vi } from 'vitest';
import { describeError, recordIntegrationError, redact } from '@/lib/integration-errors';
import { classifyIntuitFailure } from '@/lib/connectors/retry';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The error log — the one table in this system written specifically to be
 * handed to somebody outside AHN.
 *
 * That makes redaction the property that matters most. Everything else here is
 * about getting the intuit_tid into the row, because a log Intuit's support
 * cannot look up is not much use to them.
 */

describe('redact', () => {
  it('removes bearer and basic credentials', () => {
    expect(redact('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payloadpayload.signaturesig')).not.toMatch(
      /eyJhbGciOiJSUzI1NiJ9\.payload/,
    );
    expect(redact('header was Basic QUJDOmRlZmdoaWprbG1ubw==')).toBe('header was Basic [redacted]');
  });

  it('removes token-shaped key/value pairs, however they are quoted', () => {
    expect(redact('refresh_token=AB11700000000abcdefghijk')).toBe('refresh_token=[redacted]');
    expect(redact('{"access_token":"eyJraWQiOiJ0ZXN0In0x"}')).toBe('{"access_token":"[redacted]"}');
    expect(redact('client_secret: s3cr3tvalue99')).toBe('client_secret: [redacted]');
  });

  it('removes a bare JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redact(`token was ${jwt} ok`)).not.toContain(jwt);
  });

  it('leaves what support needs untouched', () => {
    // Over-redaction is its own failure: a log with the code and tid stripped
    // out is safe and useless.
    const line =
      'QuickBooks rejected the request (400, code 4000): Error parsing query [intuit_tid 1-6aa36f3e-7c887528297dc3cd2d23dbe2]';
    expect(redact(line)).toBe(line);
    expect(redact('QuickBooks refused the authorisation (400): invalid_grant — expired, already used, or revoked')).toBe(
      'QuickBooks refused the authorisation (400): invalid_grant — expired, already used, or revoked',
    );
  });

  it('caps the length', () => {
    expect(redact('x'.repeat(10_000)).length).toBe(2000);
  });
});

describe('describeError', () => {
  it('takes kind, status, fault code and tid from a classified failure', () => {
    const err = classifyIntuitFailure(
      400,
      '{"Fault":{"Error":[{"Message":"Invalid query","code":"4001"}],"type":"ValidationFault"}}',
      '1-aaa-bbb',
    );
    expect(describeError(err)).toMatchObject({
      kind: 'rejected',
      httpStatus: 400,
      faultCode: '4001',
      intuitTid: '1-aaa-bbb',
    });
  });

  it('recovers a tid folded into a plain Error — the revoke path does that', () => {
    const d = describeError(new Error('QuickBooks refused to revoke the token (500): x [intuit_tid 1-ccc-ddd]'));
    expect(d.intuitTid).toBe('1-ccc-ddd');
    expect(d.kind).toBeNull();
  });

  it('handles something that is not an Error at all', () => {
    expect(describeError('obligations: boom').message).toBe('obligations: boom');
  });
});

describe('recordIntegrationError', () => {
  const dbWith = (insert: (row: unknown) => Promise<{ error: { message: string } | null }>) =>
    ({ from: () => ({ insert }) }) as unknown as SupabaseClient;

  it('writes one row with everything support needs', async () => {
    const insert = vi.fn(async () => ({ error: null }));
    await recordIntegrationError(dbWith(insert), {
      integrationId: 'int-1',
      provider: 'quickbooks',
      operation: 'sync',
      error: classifyIntuitFailure(503, '', '1-eee-fff'),
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        integration_id: 'int-1',
        provider: 'quickbooks',
        operation: 'sync',
        kind: 'transient',
        http_status: 503,
        intuit_tid: '1-eee-fff',
      }),
    );
  });

  it('never throws — logging a failure must not become the failure', async () => {
    // It runs inside `markFailed`. If it threw, a database hiccup would abort
    // the write that tells a person their connection needs reconnecting.
    const refused = dbWith(async () => ({ error: { message: 'relation does not exist' } }));
    const exploding = dbWith(async () => {
      throw new Error('network down');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      recordIntegrationError(refused, { integrationId: null, provider: 'x', operation: 'sync', error: 'e' }),
    ).resolves.toBeUndefined();
    await expect(
      recordIntegrationError(exploding, { integrationId: null, provider: 'x', operation: 'sync', error: 'e' }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('redacts before writing, not after', async () => {
    const insert = vi.fn(async () => ({ error: null }));
    await recordIntegrationError(dbWith(insert), {
      integrationId: null,
      provider: 'quickbooks',
      operation: 'connect',
      error: new Error('exchange failed: refresh_token=AB11700000000abcdefghijk'),
    });
    const row = (insert.mock.calls[0] as unknown as [{ message: string }])[0];
    expect(row.message).not.toContain('AB11700000000abcdefghijk');
  });
});
