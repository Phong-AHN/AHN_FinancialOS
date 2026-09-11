import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { encryptSecret } from '@/lib/crypto';
import { syncQuickBooks } from '@/lib/sync';
import type { Integration } from '@/lib/types';

/**
 * A dead QuickBooks grant, end to end, against Intuit's real token endpoint.
 *
 * WHAT THIS ACTUALLY DOES. It creates a throwaway integration row holding a
 * deliberately invalid refresh token, and syncs it. Intuit really is asked to
 * refresh it, really does answer `invalid_grant`, and the assertions are about
 * what this system does next. Nothing is mocked on the provider side, so this
 * is the only test that proves the classification matches what Intuit sends
 * rather than what I believed it sends.
 *
 * IT NEVER TOUCHES THE REAL CONNECTION. The probe row has its own `external_id`
 * and is deleted afterwards. AHN's live QuickBooks connection is not read, not
 * refreshed and not revoked — exercising the success path against it would end
 * the working session for the sake of a test.
 *
 * NOTHING IS SENT TO SLACK. `notifyReconnectNeeded` fans out to every channel
 * `channelConfigured` reports as available, and this suite deliberately runs
 * without any channel credentials in `process.env` — so the fan-out is
 * exercised, resolves to the in-app row only, and nobody's phone rings. Twelve
 * real Slack messages were once sent by a probe that did not think about this.
 *
 *   REAUTH_TEST=1 npx vitest run tests/reauth.integration.test.ts
 */
const ENABLED =
  process.env.REAUTH_TEST === '1' &&
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.QBO_CLIENT_ID &&
      process.env.QBO_CLIENT_SECRET &&
      process.env.ENCRYPTION_KEY,
  );

const PROBE_REALM = 'PROBE-reauth-realm';

describe.skipIf(!ENABLED)('a revoked QuickBooks grant', () => {
  let db: SupabaseClient;
  let probe: Integration;

  beforeAll(async () => {
    // Silence every outbound channel IN THIS PROCESS before anything runs.
    // `.env.local` carries a real Slack token, and the fan-out would use it —
    // a probe that did not think about this once sent twelve real messages
    // about sandbox invoices. Deleting the credentials is better than trusting
    // myself to remember: `channelConfigured` then reports false for all three,
    // the fan-out is still exercised, and the only row written is the in-app
    // one.
    for (const key of [
      'SLACK_BOT_TOKEN',
      'SLACK_WEBHOOK_URL',
      'RESEND_API_KEY',
      'ALERT_EMAIL_FROM',
      'ALERT_EMAIL_TO',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM_NUMBER',
      'ALERT_SMS_TO',
    ]) {
      delete process.env[key];
    }

    // Proven, not assumed.
    const { channelConfigured } = await import('@/lib/alerts/channels');
    for (const channel of ['slack', 'email', 'sms'] as const) {
      if (channelConfigured(channel)) {
        throw new Error(`${channel} is still configured — this suite would send a real message.`);
      }
    }

    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );

    await db.from('integrations').delete().eq('external_id', PROBE_REALM);

    const { data, error } = await db
      .from('integrations')
      .insert({
        provider: 'quickbooks',
        external_id: PROBE_REALM,
        label: 'PROBE reauth',
        status: 'connected',
        access_token_enc: encryptSecret('expired-access-token'),
        refresh_token_enc: encryptSecret('deliberately-invalid-refresh-token'),
        // In the past, so `getAccessToken` refreshes rather than reusing it.
        token_expires_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .select('*')
      .single();

    if (error) throw new Error(`could not create probe integration: ${error.message}`);
    probe = data as Integration;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    // The probe's error rows first — they reference the probe integration, and
    // they record a failure AHN never had.
    if (probe) await db.from('integration_errors').delete().eq('integration_id', probe.id);
    await db.from('integrations').delete().eq('external_id', PROBE_REALM);
    await db.from('notifications').delete().like('title', 'Quickbooks needs reconnecting');
  });

  it('is recorded as needing reauthorisation, not as a generic error', async () => {
    const result = await syncQuickBooks(db, probe);
    expect(result.error, 'the sync should have failed').toBeTruthy();

    const { data } = await db
      .from('integrations')
      .select('status,last_error')
      .eq('id', probe.id)
      .single();

    const row = data as { status: string; last_error: string };

    // The distinction the whole change exists for. `error` would mean "the next
    // sync will try again"; it will, forever, and it will never work.
    expect(row.status).toBe('reauth_required');

    // And what is stored is something a person can act on. "invalid_grant" is
    // accurate and useless — this string is rendered on the Integrations page.
    expect(row.last_error).toMatch(/reconnect/i);
    expect(row.last_error).not.toMatch(/invalid_grant/);
  }, 60_000);

  it('keeps the failure in the error log, where last_error would have lost it', async () => {
    // Through the real failure path — markFailed — not a hand-written insert.
    const { data } = await db
      .from('integration_errors')
      .select('provider,operation,kind,http_status,intuit_tid,message')
      .eq('integration_id', probe.id);
    const rows = (data ?? []) as Array<{ kind: string; operation: string; http_status: number; message: string; intuit_tid: string | null }>;
    console.log(`
  logged: ${rows.map((r) => `${r.operation}/${r.kind}/${r.http_status} tid=${r.intuit_tid}`).join(', ')}`);
    expect(rows.length, 'the failed sync left no error record').toBeGreaterThan(0);
    expect(rows[0]!.kind).toBe('reconnect');
    expect(rows[0]!.operation).toBe('sync');
    // And never the token that failed.
    expect(rows[0]!.message).not.toContain('deliberately-invalid-refresh-token');
  });

  it('tells somebody, once', async () => {
    const { data } = await db
      .from('notifications')
      .select('channel,severity,title,body')
      .eq('title', 'Quickbooks needs reconnecting');

    const rows = (data ?? []) as Array<{ channel: string; severity: string; body: string }>;
    expect(rows.length, 'nobody was told the connection died').toBeGreaterThan(0);
    expect(rows[0]!.severity).toBe('critical');
    expect(rows[0]!.body).toMatch(/reconnect/i);
  });

  it('does not send the same alert on every subsequent tick', async () => {
    // The condition repeats every ten minutes until a person acts. An alert
    // that fires 144 times a day is an alert everybody learns to ignore.
    const countBefore = (
      await db
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('title', 'Quickbooks needs reconnecting')
    ).count;

    const stillBroken = { ...probe, status: 'reauth_required' } as Integration;
    await syncQuickBooks(db, stillBroken);

    const countAfter = (
      await db
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('title', 'Quickbooks needs reconnecting')
    ).count;

    expect(countAfter).toBe(countBefore);
  }, 60_000);
});
