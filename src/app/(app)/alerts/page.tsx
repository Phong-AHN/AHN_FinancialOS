import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession, sessionCan } from '@/lib/auth';
import { loadAlertRules, loadNotifications } from '@/lib/data';
import { channelConfigured } from '@/lib/alerts/channels';
import { formatDateTime, relativeTime } from '@/lib/dates';
import { AlertRuleRow } from '@/components/AlertRuleRow';
import { TestAlertButton } from '@/components/TestAlertButton';
import { TestTransactionButton } from '@/components/TestTransactionButton';
import type { NotificationChannel } from '@/lib/types';
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  FormulaNote,
  PageHeader,
  SectionHeader,
  SeverityBadge,
  StatTile,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Alert configuration and delivery log - Spec sections 4, 5, 6.
 *
 * The delivery log is not decoration. An alerting product whose alerts silently
 * fail is worse than no alerting at all, because the CEO stops watching for
 * them. Every attempt is recorded with its channel, status and error.
 */
export default async function AlertsPage() {
  // The session check and the data query start together. `requireSession()`
  // costs a round trip to the Auth server in Tokyo, and running it first meant
  // every page waited for it before asking for a single row. RLS is the real
  // boundary - a request without a valid session gets nothing back from these
  // queries anyway - and `redirect()` throws before anything renders, so a
  // signed-out visitor still sees the login screen and never sees data.
  const supabase = createSupabaseServerClient();

  const [session, rules, notifications] = await Promise.all([
    requireSession(),
    loadAlertRules(supabase),
    loadNotifications(supabase, 80),
  ]);
  const canEdit = sessionCan(session, 'move_money');

  const channels: NotificationChannel[] = ['slack', 'email', 'sms'];
  const channelStatus = Object.fromEntries(
    channels.map((c) => [c, channelConfigured(c)]),
  ) as Record<string, boolean>;

  const unconfigured = channels.filter((c) => !channelStatus[c]);
  const sent = notifications.filter((n) => n.status === 'sent').length;
  const failed = notifications.filter((n) => n.status === 'failed').length;
  const skipped = notifications.filter((n) => n.status === 'skipped').length;
  const lastSent = notifications.find((n) => n.status === 'sent');

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Every dollar in and out, on the channels you choose. Default mode is every dollar, no minimum."
        action={canEdit ? <TestAlertButton /> : undefined}
      />

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <StatTile label="Delivered" value={String(sent)} hint="In the last 80 attempts" tone="inflow" />
        <StatTile label="Failed" value={String(failed)} hint="Provider rejected or timed out" tone={failed > 0 ? 'outflow' : 'neutral'} />
        <StatTile label="Skipped" value={String(skipped)} hint="Channel not configured" tone={skipped > 0 ? 'warn' : 'neutral'} />
        <StatTile
          label="Last alert"
          value={lastSent ? relativeTime(lastSent.sent_at ?? lastSent.created_at) : 'never'}
          hint={lastSent?.title ?? 'No alert has been delivered yet'}
        />
      </div>

      {unconfigured.length > 0 && (
        <div className="mb-6">
          <Callout tone="warn" title={`${unconfigured.join(', ')} not configured`}>
            Rules can be switched on for these channels, but delivery will be recorded as
            <em> skipped</em> until the credentials are set in the environment. Slack needs{' '}
            <code>SLACK_BOT_TOKEN</code> plus <code>SLACK_DEFAULT_CHANNEL</code> (or{' '}
            <code>SLACK_WEBHOOK_URL</code>), email needs <code>RESEND_API_KEY</code>,{' '}
            <code>ALERT_EMAIL_FROM</code> and <code>ALERT_EMAIL_TO</code>, SMS needs the three{' '}
            <code>TWILIO_*</code> values and <code>ALERT_SMS_TO</code>.
          </Callout>
        </div>
      )}

      {/* ── End-to-end check (MVP Plan Day 4) ─────────────────────────────── */}
      {canEdit && (
        <Card className="mb-4">
          <SectionHeader
            title="End-to-end test"
            subtitle="Creates a real transaction, runs the real rule engine, and delivers on the real channels."
          />
          <TestTransactionButton />
          <FormulaNote>
            The test transaction is quarantined: it lands in an inactive, non-cash account and is
            flagged as an internal transfer, so cash, revenue, burn, runway and break-even cannot
            see it. It is kept rather than deleted, so the transaction page shows which channels
            fired — that page is the Day-7 demo.
          </FormulaNote>
        </Card>
      )}

      {/* ── Rules ─────────────────────────────────────────────────────────── */}
      <Card padded={false} className="mb-4">
        <div className="p-5 pb-0">
          <SectionHeader
            title="Rules"
            subtitle={
              canEdit
                ? 'Changes save as you make them.'
                : 'Read-only — alert configuration is restricted to the owner role.'
            }
          />
        </div>
        {rules.length === 0 ? (
          <EmptyState
            title="No rules yet"
            body="Run the 0003_defaults migration to install the week-1 alert set."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Severity</th>
                <th>Threshold</th>
                <th>Channels</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <AlertRuleRow key={rule.id} rule={rule} canEdit={canEdit} channelStatus={channelStatus} />
              ))}
            </tbody>
          </table>
        )}
        <FormulaNote>
          When one transaction matches several rules, it produces a single alert carrying the
          highest severity and the union of the channels — so a large payroll run sends one Slack
          message and one SMS, not two of each.
        </FormulaNote>
      </Card>

      {/* ── Delivery log ──────────────────────────────────────────────────── */}
      <Card padded={false}>
        <div className="p-5 pb-0">
          <SectionHeader title="Delivery log" subtitle="The last 80 attempts, newest first." />
        </div>
        {notifications.length === 0 ? (
          <EmptyState
            title="Nothing sent yet"
            body="Alerts fire as transactions arrive. Use “Send test alert” to check the wiring end to end."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Alert</th>
                <th>Channel</th>
                <th>Severity</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {notifications.map((n) => (
                <tr key={n.id}>
                  <td className="muted whitespace-nowrap">{formatDateTime(n.sent_at ?? n.created_at)}</td>
                  <td>
                    {n.transaction_id ? (
                      <Link href={`/transactions/${n.transaction_id}`} className="font-medium hover:underline">
                        {n.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{n.title}</span>
                    )}
                    <span className="faint mt-0.5 block max-w-[520px] truncate text-[11.5px]">{n.body}</span>
                  </td>
                  <td className="capitalize">{n.channel.replace('_', '-')}</td>
                  <td>
                    <SeverityBadge severity={n.severity} />
                  </td>
                  <td>
                    <Badge tone={n.status === 'sent' ? 'inflow' : n.status === 'failed' ? 'outflow' : 'neutral'}>
                      {n.status}
                    </Badge>
                    {n.error && <span className="faint mt-0.5 block text-[11px]">{n.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
