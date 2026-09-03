import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { verifySlackRequest, VERIFY_MESSAGES } from '@/lib/slack/verify';
import {
  COMMAND_CAPABILITY,
  commandNeedsExplain,
  forbiddenReply,
  formatBreakEven,
  formatBurn,
  formatCash,
  formatRunway,
  formatSpend,
  formatUnusual,
  helpText,
  parseCommand,
  unlinkedReply,
  type SlackReply,
} from '@/lib/slack/commands';
import { can } from '@/lib/capabilities';
import { loadDashboard, loadExplainBoard } from '@/lib/data';
import { today } from '@/lib/dates';
import type { UserRole } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Slash commands - Spec section 5.
 *
 * TWO GATES, AND THE SECOND IS THE ONE THAT MATTERS.
 *
 * The first is Slack's signature: without it anyone who learns this URL can ask
 * the company how much cash it has, because the `user_id` in the body is just a
 * form field the sender wrote.
 *
 * The second is identity. A verified request only proves *Slack* sent it — it
 * says nothing about whether that person may see AHN's money. Slack workspace
 * membership is not AHN's permission model: contractors, agency staff and every
 * future hire sit in the same workspace. So the Slack id is looked up in
 * `users`, and that row's role decides the answer. An unmapped id is refused by
 * name rather than answered generously.
 *
 * Without that second gate this endpoint would be a hole straight through the
 * roles enforced in migrations 0022-0025 — RLS on every table, and then one
 * slash command handing the whole picture to the room.
 *
 * WHY THE SERVICE ROLE IS SAFE HERE. There is no Supabase session behind a
 * Slack request, so RLS cannot identify the caller and the admin client is the
 * only way to read anything. That makes the capability check above the ONLY
 * boundary, which is why it runs before a single row is fetched and why every
 * command is read-only.
 */
export async function POST(request: Request) {
  // The raw bytes, before any parsing. Re-serialising parsed form data changes
  // ordering and encoding, and the signature then never matches.
  const rawBody = await request.text();

  const verdict = verifySlackRequest(rawBody, {
    signature: request.headers.get('x-slack-signature'),
    timestamp: request.headers.get('x-slack-request-timestamp'),
  });

  if (!verdict.ok) {
    // 401 with no detail. Telling an unverified caller which check failed helps
    // nobody but the caller.
    console.warn(`[slack] rejected: ${VERIFY_MESSAGES[verdict.failure ?? 'bad-signature']}`);
    return new Response('Unauthorized.', { status: 401 });
  }

  if (!isAdminConfigured()) {
    return json({
      response_type: 'ephemeral',
      text: 'The server is not configured to read financial data.',
    });
  }

  const form = new URLSearchParams(rawBody);
  const slackUserId = form.get('user_id') ?? '';
  const command = parseCommand(form.get('text') ?? '');

  if (command.name === 'help') return json(helpText(command.unknownWord));
  if (!slackUserId) return json(unlinkedReply('unknown'));

  const db = createSupabaseAdminClient();

  const { data: userRow } = await db
    .from('users')
    .select('id,email,role')
    .eq('slack_user_id', slackUserId)
    .maybeSingle();

  if (!userRow) return json(unlinkedReply(slackUserId));

  const role = (userRow as { role: UserRole }).role;
  const needed = COMMAND_CAPABILITY[command.name];
  if (!can(role, needed)) return json(forbiddenReply(role));

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';
  const asOf = today();

  try {
    if (commandNeedsExplain(command.name)) {
      const board = await loadExplainBoard(db, asOf, command.days);
      return json(
        command.name === 'spend'
          ? formatSpend(board.cashChange, command.days, appUrl)
          : formatUnusual(board.anomalies, appUrl),
      );
    }

    const { snapshot } = await loadDashboard(db, asOf);
    switch (command.name) {
      case 'cash':
        return json(formatCash(snapshot, appUrl));
      case 'runway':
        return json(formatRunway(snapshot, appUrl));
      case 'burn':
        return json(formatBurn(snapshot, appUrl));
      case 'breakeven':
        return json(formatBreakEven(snapshot, appUrl));
    }
  } catch (err) {
    // A stack trace must not reach a chat window. It names tables and columns
    // to a reader who has already been told they may ask questions here.
    console.error('[slack] command failed', err);
    return json({
      response_type: 'ephemeral',
      text: 'Something went wrong reading that. It has been logged.',
    });
  }

  return json(helpText());
}

function json(reply: SlackReply) {
  return Response.json(reply, { headers: { 'cache-control': 'no-store' } });
}
