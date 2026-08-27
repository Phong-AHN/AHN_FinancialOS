import { requireApiSession } from '@/lib/auth';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { syncAllIntegrations } from '@/lib/sync';
import { flagCrossSourceDuplicates } from '@/lib/ingest';
import { runThresholdAlerts, runTransactionAlerts } from '@/lib/alerts/engine';
import { today } from '@/lib/dates';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Manual "Sync now" from the UI. Same work as the cron, triggered by a person.
 *
 * Runs under the service-role client because ingestion writes on behalf of the
 * system (creating accounts, counterparties, flagging duplicates) rather than
 * on behalf of the signed-in user - but only after confirming that the caller
 * really is a signed-in owner.
 */
export async function POST() {
  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  if (!isAdminConfigured()) {
    return Response.json(
      { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not set, so syncing cannot run.' },
      { status: 500 },
    );
  }

  const db = createSupabaseAdminClient();
  const asOf = today();

  try {
    const results = await syncAllIntegrations(db, asOf);
    // Runs even when no integration is connected: CSV imports and direct
    // writes create duplicates too, and an unswept pair double-counts cash.
    const dedup = await flagCrossSourceDuplicates(db, asOf);
    const alerts = await runTransactionAlerts(db, { asOf });
    const thresholds = await runThresholdAlerts(db, { asOf });

    return Response.json({
      ok: true,
      results,
      dedup,
      alerts: {
        transactionsAlerted: alerts.transactionsAlerted,
        suppressedAsBackfill: alerts.suppressedAsBackfill,
        notificationsSent: alerts.notificationsSent + thresholds.notificationsSent,
        notificationsFailed: alerts.notificationsFailed + thresholds.notificationsFailed,
        errors: [...alerts.errors, ...thresholds.errors].slice(0, 5),
      },
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'Sync failed.' },
      { status: 500 },
    );
  }
}
