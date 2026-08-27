import { authorizeCron } from '@/lib/cron';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { runDigest } from '@/lib/alerts/engine';
import { today } from '@/lib/dates';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Daily (09:00) and weekly (Monday) CFO summaries - MVP Plan section 7. */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  if (!isAdminConfigured()) {
    return Response.json({ error: 'Supabase service role is not configured.' }, { status: 500 });
  }

  const period = new URL(request.url).searchParams.get('period') === 'weekly' ? 'weekly' : 'daily';
  const db = createSupabaseAdminClient();
  const summary = await runDigest(db, period, { asOf: today() });

  return Response.json({
    ok: true,
    period,
    sent: summary.notificationsSent,
    failed: summary.notificationsFailed,
    skipped: summary.notificationsSkipped,
    errors: summary.errors.slice(0, 10),
  });
}
