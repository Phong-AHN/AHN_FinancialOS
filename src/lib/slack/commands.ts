import type { FinancialSnapshot } from '@/lib/calc/engine';
import type { Capability } from '@/lib/capabilities';
import type { Anomaly, CashChange } from '@/lib/calc/explain';
import { formatMoney } from '@/lib/money';
import { formatDayLabel, formatMonthLabel } from '@/lib/dates';
import { categoryLabel } from '@/lib/categorize';

/**
 * Slash commands - Spec section 5 ("Optional future enhancement: Slack commands
 * and natural-language financial queries"), plan section 8 Phase 3.
 *
 * The commands half, not the natural-language half. Every answer here is the
 * same arithmetic the dashboard shows, read out of the same engine. Nothing is
 * parsed loosely and nothing is inferred: `/ahn runway` means runway, and a
 * word this file does not know produces the help text rather than a guess at
 * what somebody meant. A finance bot that answers approximately is worse than
 * one that answers "I did not understand that".
 */

export type CommandName = 'cash' | 'runway' | 'burn' | 'breakeven' | 'spend' | 'unusual' | 'help';

export interface ParsedCommand {
  name: CommandName;
  /** Window for `spend`, in days. */
  days: number;
  /** The word we did not recognise, so the reply can name it. */
  unknownWord?: string;
}

export const DEFAULT_SPEND_DAYS = 30;
const ALLOWED_SPEND_DAYS = [7, 30, 90] as const;

/** Every command reads company-wide money. None of them writes anything. */
export const COMMAND_CAPABILITY: Record<Exclude<CommandName, 'help'>, Capability> = {
  cash: 'see_all_money',
  runway: 'see_all_money',
  burn: 'see_all_money',
  breakeven: 'see_all_money',
  spend: 'see_all_money',
  unusual: 'see_all_money',
};

const ALIASES: Record<string, CommandName> = {
  cash: 'cash',
  balance: 'cash',
  money: 'cash',
  runway: 'runway',
  burn: 'burn',
  spend: 'spend',
  spending: 'spend',
  breakeven: 'breakeven',
  'break-even': 'breakeven',
  unusual: 'unusual',
  anomalies: 'unusual',
  help: 'help',
  '': 'help',
};

export function parseCommand(text: string): ParsedCommand {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const head = words[0] ?? '';
  const name = ALIASES[head];

  const requested = words.map(Number).find((n) => Number.isFinite(n) && n > 0);
  // Snapped to the three windows the pages offer rather than accepting any
  // number: an arbitrary window invites a comparison against a figure nobody
  // else on the team is looking at.
  const days =
    requested === undefined
      ? DEFAULT_SPEND_DAYS
      : (ALLOWED_SPEND_DAYS.find((d) => d >= requested) ?? 90);

  if (!name) return { name: 'help', days, unknownWord: head };
  return { name, days };
}

/** What the endpoint has to load, so it fetches nothing a command will not use. */
export function commandNeedsExplain(name: CommandName): boolean {
  return name === 'spend' || name === 'unusual';
}

export interface SlackReply {
  /**
   * Always ephemeral. Every command is gated on the asking person's role, and
   * posting the answer into the channel would hand it to everyone in the room
   * regardless of theirs — which would make the permission check decorative.
   * Someone who wants to share a figure can paste it themselves, deliberately.
   */
  response_type: 'ephemeral';
  text: string;
}

const reply = (text: string): SlackReply => ({ response_type: 'ephemeral', text });

export function helpText(unknownWord?: string): SlackReply {
  const preamble = unknownWord
    ? `I do not know \`${unknownWord}\`. Here is everything I do know:`
    : '*AHN Financial OS* — every answer is the same figure the dashboard shows.';

  return reply(
    [
      preamble,
      '',
      '`/ahn cash` — cash on hand, and what is held for duplicate review',
      '`/ahn runway` — how long the cash lasts',
      '`/ahn burn` — average monthly spend and the worst month on record',
      '`/ahn breakeven` — revenue still needed this month',
      '`/ahn spend [7|30|90]` — where the money went',
      '`/ahn unusual` — payments that are odd for the vendor that charged them',
      '',
      '_Answers are only ever shown to you, never posted to the channel._',
    ].join('\n'),
  );
}

export function formatCash(s: FinancialSnapshot, appUrl: string): SlackReply {
  const lines = [
    `*${formatMoney(s.cash.totalUsdMinor)}* in cash, as of ${formatDayLabel(s.asOf)}`,
  ];

  if (s.cash.byCurrency.length > 1) {
    lines.push(
      s.cash.byCurrency
        .map((c) => `${c.currency} ${formatMoney(c.totalUsdMinor)}`)
        .join('  ·  '),
    );
  }
  if (s.cash.heldForReviewUsdMinor > 0) {
    lines.push(
      `${formatMoney(s.cash.heldForReviewUsdMinor)} is held out of that total pending duplicate review.`,
    );
  }
  if (s.cash.unreconciledAccounts > 0) {
    /*
     * Worded carefully, because the obvious wording is wrong.
     *
     * "17 accounts do not reconcile" next to the cash figure reads as "this
     * number is suspect". It is not: `balanceMinor` uses the provider's
     * reported balance wherever there is one, so the total IS the banks' own.
     * What the variance actually says is that our transaction history does not
     * yet explain that balance — history older than the first sync, or an
     * opening balance nobody has set.
     *
     * That is worth knowing and it is not an alarm. A siren on every `/ahn
     * cash`, over a condition that is expected until opening balances are
     * entered, is how people learn to skip the line that one day matters.
     */
    lines.push(
      `Taken from what the providers report. On ${s.cash.unreconciledAccounts} account(s) our ` +
        'transaction history does not yet fully explain that balance — usually history older ' +
        'than the first sync, or an opening balance not set.',
    );
  }
  lines.push(`<${appUrl}/accounts|Open accounts>`);
  return reply(lines.join('\n'));
}

export function formatRunway(s: FinancialSnapshot, appUrl: string): SlackReply {
  const { runway, burn } = s;
  const lines: string[] = [];

  if (!burn.hasEnoughData) {
    // Not one complete month yet. Saying "infinite runway" here would be a
    // reassurance built on nothing.
    return reply(
      'There is not a complete month of data yet, so runway cannot be calculated honestly.\n' +
        `<${appUrl}/|Open the dashboard>`,
    );
  }

  lines.push(
    runway.grossMonths === null
      ? 'Runway if revenue stopped: not calculable — no operating outflow on record.'
      : `*${runway.grossMonths.toFixed(1)} months* if revenue stopped ` +
        `(${formatMoney(burn.monthlyBurnUsdMinor)}/mo spend)`,
  );

  lines.push(
    runway.cashPositive
      ? 'At the current rate the company is *cash positive* — revenue covered spend across the whole window, so there is no net burn to divide into.'
      : runway.netMonths === null
        ? 'At current net burn: not calculable.'
        : `*${runway.netMonths.toFixed(1)} months* at current net burn ` +
          `(${formatMoney(burn.netMonthlyBurnUsdMinor)}/mo net)`,
  );

  if (runway.worstCaseMonths !== null && burn.worstMonth) {
    lines.push(
      `*${runway.worstCaseMonths.toFixed(1)} months* if every month looked like ` +
        `${formatMonthLabel(burn.worstMonth)}, the worst on record ` +
        `(${formatMoney(burn.worstMonthOutflowUsdMinor)})`,
    );
  }

  lines.push(`<${appUrl}/|Open the dashboard>`);
  return reply(lines.join('\n'));
}

export function formatBurn(s: FinancialSnapshot, appUrl: string): SlackReply {
  const { burn } = s;
  if (!burn.hasEnoughData) {
    return reply('There is not a complete month of data yet, so burn cannot be averaged.');
  }

  const lines = [
    `*${formatMoney(burn.monthlyBurnUsdMinor)}* average monthly spend ` +
      `over ${burn.monthsSampled} month(s)`,
    `*${formatMoney(burn.netMonthlyBurnUsdMinor)}* net, after revenue`,
  ];
  if (burn.worstMonth) {
    lines.push(
      `Worst month: ${formatMonthLabel(burn.worstMonth)} at ` +
        `${formatMoney(burn.worstMonthOutflowUsdMinor)}`,
    );
  }
  lines.push(`<${appUrl}/transactions|See the transactions>`);
  return reply(lines.join('\n'));
}

export function formatBreakEven(s: FinancialSnapshot, appUrl: string): SlackReply {
  const b = s.breakEven;
  const lines = [
    `*${formatMoney(b.requiredRevenueUsdMinor)}* is needed this month to break even.`,
    `${formatMoney(b.revenueReceivedUsdMinor)} received so far, ` +
      `${b.daysElapsed} day(s) in with ${b.daysRemaining} to go.`,
  ];
  lines.push(
    b.gapUsdMinor > 0
      ? `*${formatMoney(b.gapUsdMinor)}* still to go.`
      : `Break-even passed — *${formatMoney(b.surplusUsdMinor)}* above it.`,
  );
  lines.push(`<${appUrl}/|Open the dashboard>`);
  return reply(lines.join('\n'));
}

export function formatSpend(change: CashChange, days: number, appUrl: string): SlackReply {
  if (change.outflowUsdMinor === 0) {
    return reply(`Nothing went out in the last ${days} days.`);
  }

  const top = change.outflowDrivers.slice(0, 5);
  const lines = [
    `*${formatMoney(change.outflowUsdMinor)}* went out in the last ${days} days, ` +
      `against ${formatMoney(change.inflowUsdMinor)} in.`,
    '',
    ...top.map(
      (d) =>
        `• ${categoryLabel(d.label)} — ${formatMoney(d.amountUsdMinor)} ` +
        `(${Math.round(d.share * 100)}%, ${d.count} payment${d.count === 1 ? '' : 's'})`,
    ),
  ];

  if (!change.reconciles) {
    // Never let this pass silently into Slack. If the breakdown does not add
    // up, saying so is the only honest option.
    lines.push('', ':warning: This breakdown does not reconcile with the closing balance.');
  }

  lines.push('', `<${appUrl}/explain?days=${days}|See what changed>`);
  return reply(lines.join('\n'));
}

export function formatUnusual(anomalies: Anomaly[], appUrl: string): SlackReply {
  if (anomalies.length === 0) {
    return reply(
      'Nothing recent is unusual for the vendor that charged it.\n' +
        '_Judged against each vendor’s own history, so a large but ordinary payroll run does not appear here._',
    );
  }

  const lines = [
    `*${anomalies.length}* payment${anomalies.length === 1 ? ' is' : 's are'} unusual for the vendor that charged ${anomalies.length === 1 ? 'it' : 'them'}:`,
    '',
    ...anomalies.slice(0, 5).map((a) => {
      const also = a.alsoUnusualCount > 0 ? ` (+${a.alsoUnusualCount} more from them)` : '';
      return (
        `• *${a.label}* — ${formatMoney(a.amountUsdMinor)} on ${formatDayLabel(a.transaction.txn_date)}, ` +
        `${a.multiple.toFixed(1)}× their usual${also}`
      );
    }),
  ];
  lines.push('', `<${appUrl}/explain|See what changed>`);
  return reply(lines.join('\n'));
}

/** Refusals, worded so the reader knows what to do next rather than just "no". */
export function unlinkedReply(slackUserId: string): SlackReply {
  return {
    response_type: 'ephemeral',
    text:
      `Your Slack account (\`${slackUserId}\`) is not linked to an AHN Financial OS user, ` +
      'so I cannot tell what you are allowed to see.\n' +
      'Ask the owner to link it — being in this workspace is not by itself permission to read the company’s finances.',
  };
}

export function forbiddenReply(role: string): SlackReply {
  return {
    response_type: 'ephemeral',
    text: `Your role (${role}) does not include seeing company-wide money, so I cannot answer that here.`,
  };
}
