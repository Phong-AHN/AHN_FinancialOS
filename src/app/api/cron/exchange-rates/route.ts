import { authorizeCron } from '@/lib/cron';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { refreshRates } from '@/lib/fx';
import { today } from '@/lib/dates';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily exchange rates - Spec section 3, plan section 8 Phase 3.
 *
 * Its own endpoint on its own daily tick, deliberately not on the sync tick.
 * Vietcombank publishes once or twice a day and asks for no more than one
 * request every five minutes; the sync runs far more often than that, and a
 * feed that gets the company rate-limited is worse than one that runs late.
 *
 * A run that writes nothing is a normal outcome, not a failure: at a weekend
 * the bank republishes Friday's file, the rate is unchanged, and the dated
 * lookup goes on serving Friday's number correctly.
 *
 * The response reports refusals separately from failures on purpose. A refused
 * rate means the feed answered and we did not believe it - somebody should look
 * at that, and it must not be lost inside a count of "problems".
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  if (!isAdminConfigured()) {
    return Response.json({ error: 'Supabase service role is not configured.' }, { status: 500 });
  }

  const db = createSupabaseAdminClient();
  const startedAt = Date.now();
  const result = await refreshRates(db, { asOf: today() });

  return Response.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    asOf: result.asOf,
    written: result.written,
    unchanged: result.unchanged,
    keptManual: result.keptManual,
    refused: result.refused,
    problems: result.problems,
  });
}
