import { authorizeCron } from '@/lib/cron';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { runPriceIncreaseAlerts } from '@/lib/alerts/engine';
import { today } from '@/lib/dates';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Price-increase sweep - Spec section 8. Its own endpoint, once a day.
 *
 * It does NOT belong on the sync tick. Two reasons, and the second is the one
 * that would have bitten in production:
 *
 *   1. It re-scans three years of outflows to rebuild the recurring-charge
 *      picture. Doing that every few minutes to catch an event that happens at
 *      most monthly is pure waste.
 *
 *   2. The sync tick already runs four steps under a 60-second ceiling, and a
 *      measured run of this pass alone varied between 1.8 and 46 seconds — the
 *      spread is in write latency, not in any one request, which the 10-second
 *      per-request timeout already bounds. Stacked on top of a sync, that is a
 *      timeout that would take the whole tick down, including the ordinary
 *      money-in and money-out alerts.
 *
 * Nothing is lost by the delay: a rise is deduped by vendor and change date, so
 * whenever it fires, it announces each rise exactly once.
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  if (!isAdminConfigured()) {
    return Response.json({ error: 'Supabase service role is not configured.' }, { status: 500 });
  }

  const db = createSupabaseAdminClient();
  const startedAt = Date.now();
  const summary = await runPriceIncreaseAlerts(db, { asOf: today() });

  return Response.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    sent: summary.notificationsSent,
    failed: summary.notificationsFailed,
    skipped: summary.notificationsSkipped,
    errors: summary.errors.slice(0, 10),
  });
}
