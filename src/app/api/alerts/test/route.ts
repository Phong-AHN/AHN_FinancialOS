import { requireApiSession } from '@/lib/auth';
import { callerKey, crossOriginRefusal, rateLimitRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { channelConfigured, deliver } from '@/lib/alerts/channels';
import { formatThresholdAlert } from '@/lib/alerts/format';
import { loadDashboard } from '@/lib/data';
import { formatMoney, formatMonths } from '@/lib/money';
import { today } from '@/lib/dates';
import type { NotificationChannel } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * End-to-end delivery check across every configured channel.
 *
 * The test message carries the REAL current cash and runway rather than made-up
 * figures. It proves the whole path in one shot - database read, calc engine,
 * formatting, provider credentials - and it is obvious at a glance if the
 * numbers are wrong.
 */
export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  // Delivers real messages to real Slack channels. The webhook identity cannot delete
  // its own posts, so a loop here leaves mess a person has to clear by hand.
  const tooMany = rateLimitRefusal(callerKey(request, 'alert-test'), {
    limit: 6,
    windowMs: 60000,
  });
  if (tooMany) return tooMany;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  const supabase = createSupabaseServerClient();
  const asOf = today();
  const { snapshot } = await loadDashboard(supabase, asOf);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';
  const alert = formatThresholdAlert({
    kind: 'low_balance',
    headline: 'Test alert from AHN Financial OS',
    detail: `Delivery is working. Current cash ${formatMoney(snapshot.cash.totalUsdMinor)}, runway ${formatMonths(snapshot.runway.headlineMonths)}, ${formatMoney(snapshot.breakEven.gapUsdMinor)} still needed to break even this month. Sent by ${auth.session.email}.`,
    url: appUrl,
    severity: 'info',
  });

  const channels: NotificationChannel[] = ['slack', 'email', 'sms'];
  const results = [];

  for (const channel of channels) {
    if (!channelConfigured(channel)) {
      results.push({ channel, ok: false, skipped: true, error: 'not configured' });
      continue;
    }
    const result = await deliver(channel, alert);
    results.push(result);

    await supabase.from('notifications').insert({
      channel,
      severity: 'info',
      title: alert.title,
      body: alert.text,
      status: result.ok ? 'sent' : 'failed',
      error: result.error ?? null,
      sent_at: result.ok ? new Date().toISOString() : null,
    });
  }

  return Response.json({ ok: true, results });
}
