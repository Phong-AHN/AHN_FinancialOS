import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createQboSession, qboApiBase } from '@/lib/connectors/quickbooks';
import { ProviderAuthError, asTransient, classifyIntuitFailure, withRetry } from '@/lib/connectors/retry';
import { recordIntegrationError } from '@/lib/integration-errors';
import type { Integration } from '@/lib/types';

/**
 * Syntax and validation errors, against the real QuickBooks API.
 *
 * Intuit's review asks whether the app has been TESTED against API errors
 * "including syntax and validation errors". This is that test. Every request
 * here is a deliberately broken READ — nothing is written to the company.
 *
 * What it proved the first time it ran: Intuit answers both kinds with 400 and
 * `Fault.type: "ValidationFault"` (codes 4000 and 4001), and the classifier
 * called them "transient" and retried each one three times. They are now
 * `rejected`, sent once, and logged with the intuit_tid.
 *
 *   QBO_ERRORS_TEST=1 npx vitest run tests/qbo-errors.integration.test.ts
 */
const ENABLED =
  process.env.QBO_ERRORS_TEST === '1' &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

describe.skipIf(!ENABLED)('Intuit error responses, live', () => {
  let db: SupabaseClient;
  let session: ReturnType<typeof createQboSession>;
  let realm: string;
  let integrationId: string;
  const logged: string[] = [];

  beforeAll(async () => {
    db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
    const { data } = await db
      .from('integrations')
      .select('*')
      .eq('provider', 'quickbooks')
      .not('refresh_token_enc', 'is', null)
      .single();
    const live = data as Integration;
    realm = live.external_id!;
    integrationId = live.id;
    session = createQboSession(live, async (tokens) => {
      await db.from('integrations').update(tokens).eq('id', live.id);
    });
  }, 60_000);

  afterEach(() => vi.restoreAllMocks());

  /** One raw query through the same classification the connector uses, counting sends. */
  async function ask(statement: string) {
    let sends = 0;
    let tid: string | null = null;
    const outcome = await session
      .run((token) =>
        withRetry(
          async () => {
            sends++;
            let res: Response;
            try {
              res = await fetch(
                `${qboApiBase()}/v3/company/${realm}/query?query=${encodeURIComponent(statement)}&minorversion=70`,
                { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
              );
            } catch (err) {
              throw asTransient('quickbooks', err);
            }
            tid = res.headers.get('intuit_tid');
            if (!res.ok) throw classifyIntuitFailure(res.status, await res.text(), tid);
            return 'ok';
          },
          { sleep: async () => {} },
        ),
      )
      .catch((err: unknown) => err);
    return { outcome, sends, tid };
  }

  it('a successful response carries an intuit_tid too', async () => {
    const { outcome, tid } = await ask('select * from Account maxresults 1');
    expect(outcome).toBe('ok');
    expect(tid, 'no intuit_tid on a successful response').toMatch(/^[A-Za-z0-9-]{10,}$/);
  }, 60_000);

  it('a SYNTAX error is rejected, sent once, with code 4000 and a tid', async () => {
    const { outcome, sends } = await ask("select * from Purchase wher TxnDate > '2026-01-01'");
    expect(outcome).toBeInstanceOf(ProviderAuthError);
    const err = outcome as ProviderAuthError;
    console.log(`\n  syntax     → ${err.kind}, code ${err.faultCode}, tid ${err.tid}, sent ${sends}×`);
    expect(err.kind).toBe('rejected');
    expect(err.faultCode).toBe('4000');
    expect(err.tid).toBeTruthy();
    expect(sends, 'a malformed query was retried').toBe(1);

    await recordIntegrationError(db, { integrationId, provider: 'quickbooks', operation: 'sync', error: err });
    logged.push(err.tid!);
  }, 60_000);

  it('a VALIDATION error is rejected, sent once, with code 4001 and a tid', async () => {
    const { outcome, sends } = await ask("select * from Purchase where NoSuchField = '1'");
    const err = outcome as ProviderAuthError;
    console.log(`  validation → ${err.kind}, code ${err.faultCode}, tid ${err.tid}, sent ${sends}×`);
    expect(err.kind).toBe('rejected');
    expect(err.faultCode).toBe('4001');
    expect(err.message).toMatch(/NoSuchField/);
    expect(sends).toBe(1);

    await recordIntegrationError(db, { integrationId, provider: 'quickbooks', operation: 'sync', error: err });
    logged.push(err.tid!);
  }, 60_000);

  it('both land in the error log with the tid Intuit gave, and can be read back', async () => {
    const { data, error } = await db
      .from('integration_errors')
      .select('kind,http_status,fault_code,intuit_tid,message')
      .in('intuit_tid', logged);
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ kind: string; fault_code: string; intuit_tid: string }>;
    expect(rows.map((r) => r.fault_code).sort()).toEqual(['4000', '4001']);
    expect(rows.every((r) => r.kind === 'rejected')).toBe(true);

    // These were written by a test, not by a real failure. Removed so the
    // Integrations page does not show AHN two errors that never happened.
    await db.from('integration_errors').delete().in('intuit_tid', logged);
  }, 60_000);
});
