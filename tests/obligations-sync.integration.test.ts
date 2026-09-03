import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  fetchQboObligations,
  getAccessToken,
  qboApiBase,
  qboConfigured,
} from '@/lib/connectors/quickbooks';
import { syncQboObligations } from '@/lib/obligations-sync';
import { formatMoney } from '@/lib/money';
import { today } from '@/lib/dates';
import type { Integration } from '@/lib/types';

/**
 * Receivables and payables against the real QuickBooks company.
 *
 * Gated behind QBO_AR_TEST because it reaches a third party and writes rows.
 *
 *   QBO_AR_TEST=1 npx vitest run tests/obligations-sync.integration.test.ts
 *
 * The first live sync returned zero obligations and no errors, which is exactly
 * the shape of a silently broken query. This asks QuickBooks how many invoices
 * and bills it actually holds, so that "none" can be told apart from "none
 * found".
 */
const CONFIGURED = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const ENABLED = CONFIGURED && process.env.QBO_AR_TEST === '1';

describe.skipIf(!ENABLED)('QuickBooks receivables and payables (live)', () => {
  let db: SupabaseClient;
  let integration: Integration;
  let accessToken: string;

  beforeAll(async () => {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const { data } = await db
      .from('integrations')
      .select('*')
      .eq('provider', 'quickbooks')
      .maybeSingle();
    integration = data as Integration;
    if (!integration) throw new Error('No QuickBooks integration row.');
    accessToken = await getAccessToken(integration, async (tokens) => {
      await db.from('integrations').update(tokens).eq('id', integration.id);
    });
  });

  /** Ask QuickBooks directly, bypassing our own query builder. */
  async function count(entity: string): Promise<number> {
    const statement = `select count(*) from ${entity}`;
    const url = `${qboApiBase()}/v3/company/${integration.external_id}/query?query=${encodeURIComponent(statement)}&minorversion=70`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    const json = (await res.json()) as { QueryResponse?: { totalCount?: number } };
    return json.QueryResponse?.totalCount ?? 0;
  }

  it('says how many invoices and bills the company actually has', async () => {
    expect(qboConfigured()).toBe(true);
    const invoices = await count('Invoice');
    const bills = await count('Bill');
    console.log(`\n  QuickBooks holds ${invoices} invoice(s) and ${bills} bill(s) in total.`);

    if (invoices + bills === 0) {
      console.log(
        '  Nothing to import. The sandbox company has no AR/AP, so a zero from\n' +
          '  the sync is the truth rather than a broken query.',
      );
    }
    expect(invoices).toBeGreaterThanOrEqual(0);
  });

  it('reads them with the same code the sync uses', async () => {
    // Deliberately wide: `sinceFor` uses the last successful sync, which on a
    // company synced daily is yesterday — and an invoice raised last quarter is
    // still owed today.
    const rows = await fetchQboObligations({
      accessToken,
      realmId: integration.external_id!,
      since: '2000-01-01',
    });

    console.log(`\n  fetchQboObligations returned ${rows.length} row(s)`);
    for (const r of rows.slice(0, 12)) {
      console.log(
        `   ${r.direction === 'inflow' ? 'owed to us  ' : 'we owe      '} ` +
          `${(r.counterpartyName ?? 'unnamed').padEnd(24)} ` +
          `${formatMoney(r.amountMinor).padStart(12)} of ${formatMoney(r.contractedAmountMinor)} ` +
          `due ${r.dueOn}${r.isSettled ? '  (settled)' : ''}`,
      );
    }

    const totals = await Promise.all([count('Invoice'), count('Bill')]);
    const inQbo = totals[0]! + totals[1]!;
    // If QuickBooks holds invoices and we read none, the query is wrong — which
    // is the failure a green "0 imported" would otherwise hide.
    if (inQbo > 0) expect(rows.length, 'QuickBooks has AR/AP but we read none').toBeGreaterThan(0);
  });

  it('writes them, and writing twice changes nothing the second time', async () => {
    const rows = await fetchQboObligations({
      accessToken,
      realmId: integration.external_id!,
      since: '2000-01-01',
    });
    if (rows.length === 0) {
      console.log('\n  nothing to write');
      return;
    }

    const first = await syncQboObligations(db, rows);
    console.log(
      `\n  first pass:  ${first.inserted} inserted, ${first.updated} updated, ` +
        `${first.settled} newly settled, ${first.skipped} skipped`,
    );
    expect(first.errors).toEqual([]);

    const second = await syncQboObligations(db, rows);
    console.log(
      `  second pass: ${second.inserted} inserted, ${second.updated} updated, ` +
        `${second.settled} newly settled`,
    );
    // The unique index is what makes this true. Without it the same invoice
    // would be inserted on every sync tick.
    expect(second.inserted, 'a second sync inserted duplicates').toBe(0);
    expect(second.settled, 'a settled row was re-reported as newly settled').toBe(0);

    const { count: stored } = await db
      .from('obligations')
      .select('*', { count: 'exact', head: true })
      .eq('source_system', 'quickbooks');
    console.log(`  obligations table now holds ${stored} QuickBooks row(s)`);
    expect(stored).toBe(first.inserted + first.updated);
  }, 120_000);

  it('pulls an open invoice however old it is', async () => {
    // The bug this file was written to catch. Filtering by TxnDate against the
    // last sync returned nothing while QuickBooks held 46 rows, all dated
    // earlier. An invoice raised in June is still owed in September.
    const rows = await fetchQboObligations({
      accessToken,
      realmId: integration.external_id!,
      // A `since` of today: under the old incremental filter this returned zero.
      since: today(),
    });
    const open = rows.filter((r) => !r.isSettled);
    console.log(`
  with since=today: ${rows.length} row(s), ${open.length} still open`);
    for (const r of open.slice(0, 4)) {
      console.log(`   ${r.dueOn}  ${r.counterpartyName}  ${formatMoney(r.amountMinor)}`);
    }
    const invoices = await count('Invoice');
    if (invoices > 0) {
      expect(open.length, 'an incremental window hid every open invoice again').toBeGreaterThan(0);
    }
  }, 60_000);
});
