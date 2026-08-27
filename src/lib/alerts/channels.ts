/**
 * Alert delivery channels - Spec sections 5 (Slack), 6 (email/SMS).
 *
 * Each sender returns a result instead of throwing, because a Slack outage must
 * never abort a sync run or lose the email copy of the same alert. Failures are
 * recorded on the notification row so the reason is visible in the app.
 *
 * Everything here talks to the provider REST API over fetch - no vendor SDKs to
 * keep in sync, and no surprise transitive dependencies handling money data.
 */

import type { NotificationChannel } from '@/lib/types';
import { toSlackBlocks, type FormattedAlert } from '@/lib/alerts/format';

export interface DeliveryResult {
  channel: NotificationChannel;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

const TIMEOUT_MS = 10_000;

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Slack ──────────────────────────────────────────────────────────────────

/**
 * Prefers the bot token (chat.postMessage) because it supports per-alert-type
 * channel routing, which spec section 5 requires. Falls back to the incoming
 * webhook when only that is configured.
 */
export async function sendSlack(
  alert: FormattedAlert,
  channelOverride?: string | null,
): Promise<DeliveryResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  const webhook = process.env.SLACK_WEBHOOK_URL;
  const channel = channelOverride || process.env.SLACK_DEFAULT_CHANNEL;

  if (!token && !webhook) {
    return { channel: 'slack', ok: false, skipped: true, error: 'Slack not configured' };
  }

  try {
    if (token && channel) {
      let json = await postSlackMessage(token, channel, alert);

      // The bot can be removed from a channel at any time, and the alert that
      // discovers it is the one that gets lost. With the channels:join scope we
      // can put ourselves back and deliver it - but conversations.join takes a
      // channel ID only, and resolving a #name to an ID needs channels:read,
      // which is a separate grant. So this self-heals when the channel is
      // configured as an ID, and explains the two fixes when it is a name.
      if (!json.ok && json.error === 'not_in_channel' && looksLikeChannelId(channel)) {
        const joined = await postJson(
          'https://slack.com/api/conversations.join',
          { channel },
          { authorization: `Bearer ${token}` },
        );
        const joinResult = (await joined.json()) as { ok: boolean };
        if (joinResult.ok) json = await postSlackMessage(token, channel, alert);
      }

      return json.ok
        ? { channel: 'slack', ok: true }
        : { channel: 'slack', ok: false, error: await explainSlackError(json.error, channel, token) };
    }

    const res = await postJson(webhook!, { text: alert.title, blocks: toSlackBlocks(alert) });
    return res.ok
      ? { channel: 'slack', ok: true }
      : { channel: 'slack', ok: false, error: `webhook ${res.status}` };
  } catch (err) {
    return { channel: 'slack', ok: false, error: errorMessage(err) };
  }
}

async function postSlackMessage(
  token: string,
  channel: string,
  alert: FormattedAlert,
): Promise<{ ok: boolean; error?: string }> {
  const res = await postJson(
    'https://slack.com/api/chat.postMessage',
    { channel, text: alert.title, blocks: toSlackBlocks(alert), unfurl_links: false },
    { authorization: `Bearer ${token}` },
  );
  return (await res.json()) as { ok: boolean; error?: string };
}

/** Slack channel IDs start with C (public), G (private) or D (DM). */
export function looksLikeChannelId(channel: string): boolean {
  return /^[CGD][A-Z0-9]{6,}$/.test(channel);
}

// ─── Email (Resend) ─────────────────────────────────────────────────────────

export async function sendEmail(
  alert: FormattedAlert,
  toOverride?: string | string[] | null,
): Promise<DeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_EMAIL_FROM;
  const to = normalizeRecipients(toOverride ?? process.env.ALERT_EMAIL_TO);

  if (!apiKey || !from || to.length === 0) {
    return { channel: 'email', ok: false, skipped: true, error: 'Email not configured' };
  }

  try {
    const res = await postJson(
      'https://api.resend.com/emails',
      { from, to, subject: alert.title, html: alert.html, text: alert.text },
      { authorization: `Bearer ${apiKey}` },
    );
    if (res.ok) return { channel: 'email', ok: true };
    const detail = await res.text();
    return { channel: 'email', ok: false, error: `resend ${res.status}: ${detail.slice(0, 200)}` };
  } catch (err) {
    return { channel: 'email', ok: false, error: errorMessage(err) };
  }
}

// ─── SMS (Twilio) ───────────────────────────────────────────────────────────

/**
 * Reserved for warning/critical severity (MVP Plan section 7). An every-dollar
 * SMS would be unusable noise and a real bill.
 */
export async function sendSms(
  alert: FormattedAlert,
  toOverride?: string | null,
): Promise<DeliveryResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const to = toOverride ?? process.env.ALERT_SMS_TO;

  if (!sid || !token || !from || !to) {
    return { channel: 'sms', ok: false, skipped: true, error: 'SMS not configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ From: from, To: to, Body: alert.sms });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    });
    if (res.ok) return { channel: 'sms', ok: true };
    const detail = await res.text();
    return { channel: 'sms', ok: false, error: `twilio ${res.status}: ${detail.slice(0, 200)}` };
  } catch (err) {
    return { channel: 'sms', ok: false, error: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export async function deliver(
  channel: NotificationChannel,
  alert: FormattedAlert,
  routing: { slackChannel?: string | null; email?: string | null; sms?: string | null } = {},
): Promise<DeliveryResult> {
  switch (channel) {
    case 'slack':
      return sendSlack(alert, routing.slackChannel);
    case 'email':
      return sendEmail(alert, routing.email);
    case 'sms':
      return sendSms(alert, routing.sms);
    case 'in_app':
      // The notification row itself IS the in-app delivery.
      return { channel: 'in_app', ok: true };
    default:
      return { channel, ok: false, error: `Unknown channel ${channel}` };
  }
}

export function channelConfigured(channel: NotificationChannel): boolean {
  switch (channel) {
    case 'slack':
      return Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_WEBHOOK_URL);
    case 'email':
      return Boolean(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_FROM && process.env.ALERT_EMAIL_TO);
    case 'sms':
      return Boolean(
        process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER && process.env.ALERT_SMS_TO,
      );
    case 'in_app':
      return true;
    default:
      return false;
  }
}

/**
 * Slack's error codes are terse enough to send someone hunting in the wrong
 * place. `not_in_channel` in particular reads like a permissions problem when
 * the fix is one `/invite`, and it is the single most likely reason a correctly
 * configured alert never arrives.
 */
async function explainSlackError(
  code: string | undefined,
  channel: string,
  token: string,
): Promise<string> {
  switch (code) {
    case 'not_in_channel': {
      // Worth one extra call on an error path: "/invite @ahn_financialos" is a
      // fix someone can act on, "/invite @your-bot-name" is a riddle.
      const bot = await slackBotHandle(token);
      if (looksLikeChannelId(channel)) {
        return `not_in_channel — the bot is not in ${channel} and could not join it. Check that the app has the channels:join scope, or run "/invite @${bot}" there.`;
      }
      return `not_in_channel — the bot is not a member of ${channel}. Run "/invite @${bot}" in that channel. (Auto-join needs the channel configured as an ID like C0123ABCDEF, because conversations.join does not accept names and resolving one needs the channels:read scope.)`;
    }
    case 'channel_not_found':
      return `channel_not_found — ${channel} does not exist, or the bot cannot see it. Check the name, and invite the bot if it is private.`;
    case 'missing_scope':
      return 'missing_scope — the bot token lacks chat:write. Add it in the Slack app OAuth settings and reinstall the app.';
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
      return `${code} — SLACK_BOT_TOKEN is invalid or revoked. Reissue it from the Slack app settings.`;
    case 'is_archived':
      return `is_archived — ${channel} is archived.`;
    case 'rate_limited':
      return 'rate_limited — Slack is throttling. The next cron tick will retry.';
    default:
      return code ?? 'slack_error';
  }
}

/** The bot's own handle, for a "/invite" instruction someone can paste. */
let cachedBotHandle: string | null = null;
async function slackBotHandle(token: string): Promise<string> {
  if (cachedBotHandle) return cachedBotHandle;
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      headers: { authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as { ok: boolean; user?: string };
    cachedBotHandle = json.ok && json.user ? json.user : 'your-bot-name';
  } catch {
    cachedBotHandle = 'your-bot-name';
  }
  return cachedBotHandle;
}

function normalizeRecipients(value: string | string[] | null | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : value.split(',');
  return list.map((s) => s.trim()).filter(Boolean);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.name === 'AbortError' ? 'timeout' : err.message;
  return String(err);
}
