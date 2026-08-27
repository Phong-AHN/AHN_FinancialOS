import { authorizeCron } from '@/lib/cron';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { syncAllIntegrations } from '@/lib/sync';
import { flagCrossSourceDuplicates } from '@/lib/ingest';
import { runThresholdAlerts, runTransactionAlerts } from '@/lib/alerts/engine';
import { today } from '@/lib/dates';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The heartbeat - MVP Plan section 3 (Vercel Cron every 5-10 minutes).
 *
 * Order matters:
 *   1. pull new transactions from every connected source
 *   2. sweep for cross-source duplicates
 *   3. alert on everything the engine has not seen
 *   4. evaluate state thresholds - runway, account balances
 *
 * Step 2 runs unconditionally, not only when an integration produced rows.
 * Duplicates also arrive through CSV imports and direct writes, and a company
 * with no integrations connected yet would otherwise never have the sweep run
 * at all - silently double-counting every pair.
 *
 * Alerting after ingest is what makes the "current total cash" figure inside
 * each alert correct: it already includes the transaction being announced.
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  if (!isAdminConfigured()) {
    return Response.json({ error: 'Supabase service role is not configured.' }, { status: 500 });
  }

  const db = createSupabaseAdminClient();
  const asOf = today();
  const startedAt = Date.now();

  const syncResults = await syncAllIntegrations(db, asOf);
  const dedup = await flagCrossSourceDuplicates(db, asOf);
  const transactionAlerts = await runTransactionAlerts(db, { asOf, limit: 100 });
  const thresholdAlerts = await runThresholdAlerts(db, { asOf });
  // Price increases are NOT swept here — they run on their own daily
  // endpoint. Rescanning three years of ledger on every tick to catch a
  // monthly event would put this route over its 60-second ceiling and take
  // the ordinary money-in and money-out alerts down with it.

  return Response.json({
    ok: true,
    asOf,
    durationMs: Date.now() - startedAt,
    sync: syncResults,
    dedup,
    alerts: {
      transactionsAlerted: transactionAlerts.transactionsAlerted,
      suppressedAsBackfill: transactionAlerts.suppressedAsBackfill,
      sent: transactionAlerts.notificationsSent + thresholdAlerts.notificationsSent,
      failed: transactionAlerts.notificationsFailed + thresholdAlerts.notificationsFailed,
      skipped: transactionAlerts.notificationsSkipped + thresholdAlerts.notificationsSkipped,
      errors: [...transactionAlerts.errors, ...thresholdAlerts.errors].slice(0, 10),
    },
  });
}
