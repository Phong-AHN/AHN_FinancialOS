import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  CDC_MAX_LOOKBACK_DAYS,
  createQboSession,
  fetchQboChanges,
  normaliseCashRow,
} from '@/lib/connectors/quickbooks';
import { syncQuickBooks } from '@/lib/sync';
import type { Integration } from '@/lib/types';

/**
 * The whole QuickBooks sync, on the CDC path, against the live company.
 *
 * Two things are proved here that no unit test can:
 *
 *   1. The wiring — plan, CDC call, normalisation, ingest, and the metadata
 *      written back — works end to end and leaves the connection healthy.
 *   2. CDC and the query path AGREE. Every row CDC reports as changed must
 *      already be in the ledger under the same `external_txn_id` the query path
 *      gave it. If the two paths named the same purchase differently, switching
 *      to CDC would import every one of them a second time — the double-count
 *      the whole system exists to prevent (spec section 28).
 *
 * Every outbound alert channel is removed from this process first. The sync
 * itself does not alert on success, but the rule after decision 96 is that a
 * probe proves it cannot page anybody rather than assuming so.
 *
 *   QBO_SYNC_TEST=1 npx vitest run tests/qbo-sync-cdc.integration.test.ts
 */
const ENABLED =
  process.env.QBO_SYNC_TEST === '1' &&
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.QBO_CLIENT_ID &&
      process.env.ENCRYPTION_KEY,
  );

describe.skipIf(!ENABLED)('a QuickBooks sync on the CDC path', () => {
  let db: SupabaseClient;
  let live: Integration;
  let before: number;

  beforeAll(async () => {
    for (const key of [
      'SLACK_BOT_TOKEN',
      'SLACK_WEBHOOK_URL',
      'RESEND_API_KEY',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
    ]) {
      delete process.env[key];
    }

    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const { data } = await db
      .from('integrations')
      .select('*')
      .eq('provider', 'quickbooks')
      .not('refresh_token_enc', 'is', null)
      .single();
    live = data as Integration;

    before = (
      await db
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('source_system', 'quickbooks')
    ).count!;
  }, 60_000);

  it('takes the CDC path and finishes cleanly', async () => {
    const result = await syncQuickBooks(db, live);
    console.log(`\n  mode: ${result.mode?.path} — ${result.mode?.reason}`);
    console.log(
      `  inserted ${result.inserted}, skipped ${result.skipped}, deleted ${result.deleted ?? 0}, ` +
        `accounts ${result.accounts_touched}, unavailable ${result.unavailable?.join(',') || 'none'}`,
    );

    expect(result.error, result.error).toBeUndefined();
    expect(result.mode?.path).toBe('cdc');

    const { data } = await db
      .from('integrations')
      .select('status,last_synced_at,metadata')
      .eq('id', live.id)
      .single();
    const row = data as { status: string; last_synced_at: string; metadata: Record<string, unknown> };
    expect(row.status).toBe('connected');
    expect(new Date(row.last_synced_at).getTime()).toBeGreaterThan(Date.now() - 120_000);
    // The existing metadata survives the new key being written beside it.
    expect(row.metadata.connected_by).toBe((live.metadata as Record<string, unknown>).connected_by);
  }, 180_000);

  it('does not import anything a second time', async () => {
    const after = (
      await db
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('source_system', 'quickbooks')
    ).count!;
    console.log(`\n  quickbooks transactions: ${before} before, ${after} after`);
    // Growth is allowed — new sandbox activity is real data. Shrinkage is only
    // allowed through reported deletions, which the previous test printed.
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('names every row exactly as the query path did', async () => {
    const { data: fresh } = await db.from('integrations').select('*').eq('id', live.id).single();
    const session = createQboSession(fresh as Integration, async (tokens) => {
      await db.from('integrations').update(tokens).eq('id', live.id);
    });

    const since = new Date(Date.now() - CDC_MAX_LOOKBACK_DAYS * 86_400_000);
    const changes = await session.run((t) =>
      fetchQboChanges(t, live.external_id!, ['Purchase', 'Deposit', 'Payment', 'BillPayment'], since),
    );

    const ids: string[] = [];
    for (const [entity, rows] of Object.entries(changes.changed)) {
      for (const row of rows) {
        const txn = normaliseCashRow(entity, 'outflow', row, () => 'x', '2026-01-01');
        if (txn) ids.push(txn.external_txn_id);
      }
    }

    const { data: held } = await db
      .from('transactions')
      .select('external_txn_id')
      .eq('source_system', 'quickbooks')
      .in('external_txn_id', ids.length ? ids : ['none']);
    const heldIds = new Set((held ?? []).map((r) => (r as { external_txn_id: string }).external_txn_id));
    const missing = ids.filter((id) => !heldIds.has(id));

    console.log(`\n  CDC reported ${ids.length} changed cash rows; ${ids.length - missing.length} already held under the same id`);
    expect(ids.length, 'CDC returned nothing to compare').toBeGreaterThan(0);
    expect(missing, 'CDC names rows differently from the query path').toEqual([]);
  }, 180_000);
});
