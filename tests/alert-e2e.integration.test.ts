import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { runTransactionAlerts } from '@/lib/alerts/engine';
import { channelConfigured } from '@/lib/alerts/channels';
import { today } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import type { FinancialAccount, NotificationRow } from '@/lib/types';

/**
 * MVP Plan Day 4 deliverable, end to end:
 *
 *   "create a test transaction → receive the alert within seconds"
 *
 * This DELIVERS REAL MESSAGES on every configured channel, so it is gated
 * behind ALERT_E2E=1 rather than running on every `npm test`. Nobody wants a
 * Slack notification each time the unit suite runs.
 *
 *   ALERT_E2E=1 npx vitest run tests/alert-e2e.integration.test.ts
 *
 * The transaction is quarantined exactly as the API route quarantines it: an
 * inactive, non-cash account plus `is_internal_transfer`, so no dashboard figure
 * can move. It is cleaned up afterwards; the notification rows survive.
 */
const ENABLED =
  process.env.ALERT_E2E === '1' &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

const TEST_ACCOUNT_KEY = 'alert-test-harness-vitest';

describe.skipIf(!ENABLED)('alert pipeline end-to-end (delivers real messages)', () => {
  let db: SupabaseClient;
  let accountId: string;
  const createdTransactionIds: string[] = [];

  beforeAll(async () => {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data: existing } = await db
      .from('financial_accounts')
      .select('*')
      .eq('source_system', 'manual')
      .eq('external_account_id', TEST_ACCOUNT_KEY)
      .maybeSingle();

    if (existing) {
      accountId = (existing as FinancialAccount).id;
      return;
    }

    const { data: company } = await db.from('companies').select('id').limit(1).single();
    const { data, error } = await db
      .from('financial_accounts')
      .insert({
        company_id: (company as { id: string }).id,
        name: 'Alert test harness (vitest)',
        type: 'other',
        currency: 'USD',
        source_system: 'manual',
        external_account_id: TEST_ACCOUNT_KEY,
        include_in_cash: false,
        is_active: false,
      })
      .select('id')
      .single();

    if (error) throw new Error(error.message);
    accountId = (data as { id: string }).id;
  });

  afterAll(async () => {
    // Remove the transactions; the notifications they produced stay as proof.
    if (createdTransactionIds.length) {
      await db.from('transactions').delete().in('id', createdTransactionIds);
    }
  });

  async function fire(direction: 'inflow' | 'outflow', amountMinor: number) {
    const { data, error } = await db
      .from('transactions')
      .insert({
        account_id: accountId,
        txn_date: today(),
        posted_at: new Date().toISOString(),
        amount_minor: amountMinor,
        currency: 'USD',
        direction,
        amount_usd_minor: amountMinor,
        fx_rate: 1,
        description: `TEST TRANSACTION — Day 4 pipeline check (${direction})`,
        category: 'transfer',
        is_internal_transfer: true,
        source_system: 'manual',
        external_txn_id: `${TEST_ACCOUNT_KEY}:${direction}:${Date.now()}`,
        reconciliation_status: 'unreconciled',
      })
      .select('id')
      .single();

    if (error) throw new Error(error.message);
    const id = (data as { id: string }).id;
    createdTransactionIds.push(id);

    const summary = await runTransactionAlerts(db, { transactionIds: [id] });
    const { data: notifications } = await db
      .from('notifications')
      .select('*')
      .eq('transaction_id', id);

    return { id, summary, notifications: (notifications ?? []) as NotificationRow[] };
  }

  it('fires an info alert for money in, on every configured channel', async () => {
    const { summary, notifications } = await fire('inflow', 1_250_000);

    expect(summary.transactionsAlerted).toBe(1);
    expect(notifications.length).toBeGreaterThan(0);

    for (const n of notifications) {
      console.log(
        `  in  · ${n.channel.padEnd(8)} ${n.status.padEnd(8)} ${n.error ?? ''}`,
      );
      // Every configured channel must actually deliver. A configured channel
      // that silently reports "skipped" is the failure mode this whole test
      // exists to catch.
      if (channelConfigured(n.channel)) {
        expect(n.status, `${n.channel}: ${n.error ?? ''}`).toBe('sent');
      }
    }

    const inApp = notifications.find((n) => n.channel === 'in_app');
    expect(inApp?.severity).toBe('info');
    expect(inApp?.body).toContain(formatMoney(1_250_000));
  }, 30_000);

  it('escalates a large outflow to warning severity and adds SMS', async () => {
    // $8,000 clears the default $5,000 large-outflow threshold, so this pair of
    // rules must collapse into ONE alert carrying the higher severity and the
    // union of the channels.
    const { summary, notifications } = await fire('outflow', 800_000);

    expect(summary.transactionsAlerted).toBe(1);
    for (const n of notifications) {
      console.log(
        `  out · ${n.channel.padEnd(8)} ${n.status.padEnd(8)} ${n.error ?? ''}`,
      );
    }

    const channels = notifications.map((n) => n.channel).sort();
    expect(channels).toContain('sms');
    expect(new Set(channels).size).toBe(channels.length); // no channel twice

    expect(notifications[0]?.severity).toBe('warning');
  }, 30_000);

  it('leaves cash, revenue and burn untouched', async () => {
    // The whole justification for writing a fake transaction into a live ledger.
    const { data: accounts } = await db.from('financial_accounts').select('*');
    const harness = (accounts as FinancialAccount[]).find((a) => a.id === accountId)!;

    expect(harness.is_active).toBe(false);
    expect(harness.include_in_cash).toBe(false);

    const { data: rows } = await db
      .from('transactions')
      .select('is_internal_transfer')
      .in('id', createdTransactionIds);

    for (const row of rows ?? []) {
      expect((row as { is_internal_transfer: boolean }).is_internal_transfer).toBe(true);
    }
  });
});
