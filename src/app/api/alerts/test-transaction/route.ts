import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { runTransactionAlerts } from '@/lib/alerts/engine';
import { ensureDefaultCompany } from '@/lib/sync';
import { today } from '@/lib/dates';
import type { FinancialAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The Day-4 end-to-end test: create a transaction, watch it produce a real
 * alert on real channels, within seconds.
 *
 * WHY THIS IS SAFE TO RUN AGAINST A LIVE LEDGER
 *
 * Injecting invented money into a financial system to test a notification is
 * normally a bad trade. Three things quarantine it so no figure can move:
 *
 *   1. It lands in a dedicated account with `is_active = false` and
 *      `include_in_cash = false`. `computeCashPosition` filters inactive
 *      accounts outright, so cash, per-account balances and the cash trend
 *      cannot see it.
 *   2. It is marked `is_internal_transfer`, so `countsTowardPnl` excludes it
 *      from revenue, expense, burn, runway and break-even.
 *   3. Its description and counterparty say plainly that it is a test.
 *
 * The row is KEPT rather than deleted. It stays traceable, its transaction page
 * shows exactly which channels fired, and that page is the demo the plan calls
 * for on Day 7. Deleting it would leave the notification log pointing at
 * nothing - which is the shape of the stale-id bug that cost real debugging time
 * earlier in this build.
 */
const TEST_ACCOUNT_KEY = 'alert-test-harness';

const Schema = z.object({
  direction: z.enum(['inflow', 'outflow']).default('inflow'),
  /** USD cents. Defaults to the spec §4 example of $12,500 in. */
  amountMinor: z.number().int().positive().max(100_000_000).optional(),
});

export async function POST(request: Request) {
  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  if (!isAdminConfigured()) {
    return Response.json(
      { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not set.' },
      { status: 500 },
    );
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is fine; the defaults are the point.
  }

  const parsed = Schema.safeParse(body ?? {});
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'Invalid test parameters.' }, { status: 400 });
  }

  const direction = parsed.data.direction;
  // $12,500 in matches the spec §4 example. $8,000 out clears the default
  // $5,000 large-outflow threshold, so it exercises the warning + SMS path.
  const amountMinor = parsed.data.amountMinor ?? (direction === 'inflow' ? 1_250_000 : 800_000);

  const db = createSupabaseAdminClient();

  try {
    const account = await ensureTestAccount(db);
    const stamp = new Date();

    const { data: inserted, error: insertError } = await db
      .from('transactions')
      .insert({
        account_id: account.id,
        txn_date: today(),
        posted_at: stamp.toISOString(),
        amount_minor: amountMinor,
        currency: 'USD',
        direction,
        amount_usd_minor: amountMinor,
        fx_rate: 1,
        description: `TEST TRANSACTION — alert pipeline check by ${auth.session.email}`,
        category: 'transfer',
        // Quarantine: excluded from revenue, expense, burn and break-even.
        is_internal_transfer: true,
        source_system: 'manual',
        external_txn_id: `${TEST_ACCOUNT_KEY}:${stamp.getTime()}`,
        reconciliation_status: 'unreconciled',
        notes:
          'Created by the Day-4 end-to-end alert test. Quarantined in an inactive, non-cash account and flagged as an internal transfer, so it affects no dashboard figure.',
      })
      .select('id')
      .single();

    if (insertError || !inserted) {
      return Response.json(
        { ok: false, error: `Could not create the test transaction: ${insertError?.message}` },
        { status: 500 },
      );
    }

    const transactionId = (inserted as { id: string }).id;

    // Fire the REAL engine, narrowed to this one row.
    const summary = await runTransactionAlerts(db, { transactionIds: [transactionId] });

    const { data: notifications } = await db
      .from('notifications')
      .select('channel,status,error,severity,title')
      .eq('transaction_id', transactionId)
      .order('channel');

    return Response.json({
      ok: true,
      transactionId,
      url: `/transactions/${transactionId}`,
      direction,
      amountMinor,
      matched: summary.transactionsAlerted > 0,
      deliveries: notifications ?? [],
      sent: summary.notificationsSent,
      failed: summary.notificationsFailed,
      skipped: summary.notificationsSkipped,
      errors: summary.errors.slice(0, 5),
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'Test failed.' },
      { status: 500 },
    );
  }
}

/** Find or create the quarantined account the test writes into. */
async function ensureTestAccount(
  db: ReturnType<typeof createSupabaseAdminClient>,
): Promise<FinancialAccount> {
  const { data: existing } = await db
    .from('financial_accounts')
    .select('*')
    .eq('source_system', 'manual')
    .eq('external_account_id', TEST_ACCOUNT_KEY)
    .maybeSingle();

  if (existing) return existing as FinancialAccount;

  const companyId = await ensureDefaultCompany(db);
  const { data, error } = await db
    .from('financial_accounts')
    .insert({
      company_id: companyId,
      name: 'Alert test harness (not real money)',
      type: 'other',
      currency: 'USD',
      source_system: 'manual',
      external_account_id: TEST_ACCOUNT_KEY,
      include_in_cash: false,
      // Inactive is what keeps it out of the cash position entirely.
      is_active: false,
    })
    .select('*')
    .single();

  if (error) throw new Error(`Could not create the test account: ${error.message}`);
  return data as FinancialAccount;
}
