import type { SupabaseClient } from '@supabase/supabase-js';
import { channelConfigured, deliver } from '@/lib/alerts/channels';
import type { NotificationChannel } from '@/lib/types';

/**
 * Tell somebody a connection has died and needs authorising again.
 *
 * WHY THIS IS NOT JUST A BADGE ON A PAGE. The sync runs headless every ten
 * minutes. A dead QuickBooks grant produces no error anybody sees — the
 * dashboard keeps rendering, the figures keep looking like figures, they are
 * just quietly frozen at whatever the last successful pull returned. Stale
 * financials that look current are worse than an obvious outage, because
 * decisions get made on them.
 *
 * ONCE, NOT EVERY TEN MINUTES. The condition repeats on every tick until
 * somebody acts, and a system that sends the same alert 144 times a day trains
 * people to ignore it — at which point the one alert that mattered is lost in
 * the noise it created. The caller decides: it knows the status the integration
 * held BEFORE it was changed, which is the only moment the transition into
 * "needs reconnecting" is visible.
 */
export async function notifyReconnectNeeded(
  db: SupabaseClient,
  input: { provider: string; advice: string },
): Promise<void> {
  const name = input.provider.charAt(0).toUpperCase() + input.provider.slice(1);
  const title = `${name} needs reconnecting`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const url = appUrl ? `${appUrl}/integrations` : '/integrations';

  const text =
    `${input.advice}\n\n` +
    `Syncing from ${name} has stopped, and the figures in AHN Financial OS will not ` +
    `update until it is reconnected. Nothing already imported has been lost.\n\n` +
    `Reconnect: ${url}`;

  const alert = {
    title,
    text,
    // Charged per message, and 160 characters. Its whole job is to get somebody
    // to open one of the other two.
    sms: `${title}. Syncing has stopped until it is reconnected.`,
    html:
      `<p><strong>${title}</strong></p><p>${input.advice}</p>` +
      `<p>Syncing from ${name} has stopped and the figures will not update until it is ` +
      `reconnected. Nothing already imported has been lost.</p>` +
      `<p><a href="${url}">Reconnect ${name}</a></p>`,
    url,
    severity: 'critical' as const,
  };

  // Every configured channel. This is the one alert whose entire purpose is to
  // reach somebody who is not looking at the application.
  const channels: NotificationChannel[] = (['slack', 'email', 'sms'] as const).filter((c) =>
    channelConfigured(c),
  );

  for (const channel of channels) {
    let ok = false;
    let error: string | null = null;
    try {
      const result = await deliver(channel, alert);
      ok = result.ok;
      error = result.error ?? null;
    } catch (err) {
      // A failure to *notify* must never become a failure of the sync that
      // detected the problem. The row below still records that we tried.
      error = err instanceof Error ? err.message : String(err);
    }

    await db.from('notifications').insert({
      channel,
      severity: 'critical',
      title,
      body: channel === 'sms' ? alert.sms : text,
      status: ok ? 'sent' : 'failed',
      error: ok ? null : (error ?? 'unknown').slice(0, 500),
      sent_at: ok ? new Date().toISOString() : null,
    });
  }

  // Always leave an in-app record, even when no channel is configured at all.
  // Otherwise a deployment with no Slack token detects the problem and tells
  // nobody, anywhere.
  await db.from('notifications').insert({
    channel: 'in_app',
    severity: 'critical',
    title,
    body: text,
    status: 'sent',
    sent_at: new Date().toISOString(),
  });
}
