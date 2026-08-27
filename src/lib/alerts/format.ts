/**
 * Alert copy - Spec section 4 templates, MVP Plan section 7.
 *
 * The spec gives two exact example messages, and they set the bar: an alert has
 * to carry the amount, the counterparty, the account, AND the resulting company
 * position, so the CEO never has to open the app to know whether a payment
 * matters. Every message here also carries a deep link back to the transaction
 * (spec section 5).
 */

import type { AlertSeverity, TransactionWithContext } from '@/lib/types';
import { formatMoney, formatMonths } from '@/lib/money';
import { formatDayLabel } from '@/lib/dates';

export interface AlertContext {
  /** Total cash across all accounts, USD cents, after this transaction. */
  totalCashUsdMinor: number;
  runwayMonths: number | null;
  /** Month-to-date spend in this transaction category, USD cents. */
  categorySpendMtdUsdMinor?: number;
  appUrl: string;
}

export interface FormattedAlert {
  title: string;
  /** Plain text - used for email body, Slack fallback and the notifications table. */
  text: string;
  /** <=160 chars, for SMS. */
  sms: string;
  html: string;
  url: string;
  severity: AlertSeverity;
}

export function formatTransactionAlert(
  txn: TransactionWithContext,
  ctx: AlertContext,
  severity: AlertSeverity = 'info',
): FormattedAlert {
  const isInflow = txn.direction === 'inflow';
  const amount = formatMoney(txn.amount_minor, txn.currency, { signed: true });
  const signedAmount = isInflow ? amount : `−${amount.replace(/^\+/, '')}`;
  const party = txn.counterparty?.name ?? txn.description ?? 'Unknown counterparty';
  const accountName = txn.account?.name ?? 'Unknown account';
  const verb = isInflow ? 'received from' : 'sent to';

  const sentences: string[] = [`${signedAmount} ${verb} ${party}.`];
  sentences.push(`Account: ${accountName}.`);
  if (txn.category) sentences.push(`Category: ${humanize(txn.category)}.`);
  if (typeof ctx.categorySpendMtdUsdMinor === 'number' && !isInflow) {
    sentences.push(
      `Month-to-date ${humanize(txn.category ?? 'spend').toLowerCase()} spend is now ${formatMoney(
        ctx.categorySpendMtdUsdMinor,
      )}.`,
    );
  }
  sentences.push(`Current total cash: ${formatMoney(ctx.totalCashUsdMinor)}.`);
  if (ctx.runwayMonths !== null) {
    sentences.push(`Runway: ${formatMonths(ctx.runwayMonths)}.`);
  }

  const url = `${ctx.appUrl}/transactions/${txn.id}`;
  const title = `${isInflow ? 'Money in' : 'Money out'}: ${signedAmount} · ${truncate(party, 40)}`;
  const text = sentences.join(' ');

  return {
    title,
    text,
    sms: truncate(`${signedAmount} ${verb} ${party}. Cash ${formatMoney(ctx.totalCashUsdMinor, 'USD', { compact: true })}.`, 160),
    html: transactionHtml(txn, sentences, url, isInflow),
    url,
    severity,
  };
}

export interface ThresholdAlertInput {
  kind: 'low_runway' | 'low_balance' | 'large_outflow' | 'price_increase';
  headline: string;
  detail: string;
  url: string;
  severity: AlertSeverity;
}

export function formatThresholdAlert(input: ThresholdAlertInput): FormattedAlert {
  return {
    title: input.headline,
    text: `${input.headline} ${input.detail}`,
    sms: truncate(`${input.headline} ${input.detail}`, 160),
    html: simpleHtml(input.headline, [input.detail], input.url, input.severity),
    url: input.url,
    severity: input.severity,
  };
}

export interface DigestInput {
  period: 'daily' | 'weekly';
  periodLabel: string;
  inflowUsdMinor: number;
  outflowUsdMinor: number;
  netUsdMinor: number;
  txnCount: number;
  totalCashUsdMinor: number;
  runwayMonths: number | null;
  breakEvenGapUsdMinor: number;
  topOutflows: Array<{ label: string; amountUsdMinor: number; date: string }>;
  needsAttention: string[];
  appUrl: string;
}

export function formatDigest(input: DigestInput): FormattedAlert {
  const title = `${input.period === 'daily' ? 'Daily' : 'Weekly'} CFO summary — ${input.periodLabel}`;

  const lines = [
    `Money in: ${formatMoney(input.inflowUsdMinor)}`,
    `Money out: ${formatMoney(input.outflowUsdMinor)}`,
    `Net: ${formatMoney(input.netUsdMinor, 'USD', { signed: input.netUsdMinor > 0 })}`,
    `Transactions: ${input.txnCount}`,
    `Cash on hand: ${formatMoney(input.totalCashUsdMinor)}`,
    `Runway: ${formatMonths(input.runwayMonths)}`,
    input.breakEvenGapUsdMinor > 0
      ? `Still needed to break even this month: ${formatMoney(input.breakEvenGapUsdMinor)}`
      : `Break-even for the month is covered.`,
  ];

  if (input.topOutflows.length) {
    lines.push('', 'Largest outflows:');
    for (const o of input.topOutflows) {
      lines.push(`  • ${formatMoney(o.amountUsdMinor)} — ${o.label} (${formatDayLabel(o.date)})`);
    }
  }
  if (input.needsAttention.length) {
    lines.push('', 'Needs attention:');
    for (const item of input.needsAttention) lines.push(`  • ${item}`);
  }

  return {
    title,
    text: `${title}\n\n${lines.join('\n')}`,
    sms: truncate(
      `${title}: in ${formatMoney(input.inflowUsdMinor, 'USD', { compact: true })}, out ${formatMoney(input.outflowUsdMinor, 'USD', { compact: true })}, cash ${formatMoney(input.totalCashUsdMinor, 'USD', { compact: true })}.`,
      160,
    ),
    html: digestHtml(title, input),
    url: input.appUrl,
    severity: 'digest',
  };
}

// ─── Slack Block Kit ────────────────────────────────────────────────────────

export function toSlackBlocks(alert: FormattedAlert): unknown[] {
  const emoji = SEVERITY_EMOJI[alert.severity];
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${emoji} *${escapeSlack(alert.title)}*\n${escapeSlack(alert.text)}` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Financial OS' },
          url: alert.url,
        },
      ],
    },
  ];
}

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: ':moneybag:',
  warning: ':warning:',
  critical: ':rotating_light:',
  digest: ':bar_chart:',
};

function escapeSlack(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── HTML email ─────────────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  info: '#1f6feb',
  warning: '#b45309',
  critical: '#c02f43',
  digest: '#0f8a5f',
};

function shell(title: string, inner: string, url: string, severity: AlertSeverity): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0b1220">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e5ea;border-radius:12px">
<tr><td style="padding:4px;background:${SEVERITY_COLOR[severity]};border-radius:12px 12px 0 0"></td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:18px;line-height:1.35">${escapeHtml(title)}</h1>
${inner}
<p style="margin:24px 0 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1f6feb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Open in Financial OS</a></p>
</td></tr>
<tr><td style="padding:0 24px 20px;color:#6b7280;font-size:12px">AHN Financial OS — every dollar in, every dollar out.</td></tr>
</table></body></html>`;
}

function transactionHtml(
  txn: TransactionWithContext,
  sentences: string[],
  url: string,
  isInflow: boolean,
): string {
  const rows: Array<[string, string]> = [
    ['Amount', formatMoney(txn.amount_minor, txn.currency)],
    ['Direction', isInflow ? 'Inflow' : 'Outflow'],
    ['Date', formatDayLabel(txn.txn_date)],
    ['Account', txn.account?.name ?? '—'],
    ['Counterparty', txn.counterparty?.name ?? '—'],
    ['Category', humanize(txn.category ?? 'uncategorized')],
    ['Source', txn.source_system],
  ];
  const table = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px">${escapeHtml(k)}</td><td style="padding:6px 0;font-size:13px;text-align:right;font-weight:600">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const body = `<p style="margin:0 0 16px;font-size:14px;line-height:1.6">${escapeHtml(sentences.join(' '))}</p>
<table role="presentation" width="100%" style="border-top:1px solid #e2e5ea">${table}</table>`;
  return shell(
    `${isInflow ? 'Money in' : 'Money out'} — ${formatMoney(txn.amount_minor, txn.currency)}`,
    body,
    url,
    'info',
  );
}

function simpleHtml(title: string, paragraphs: string[], url: string, severity: AlertSeverity): string {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6">${escapeHtml(p)}</p>`)
    .join('');
  return shell(title, body, url, severity);
}

function digestHtml(title: string, input: DigestInput): string {
  const stat = (label: string, value: string) =>
    `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px">${label}</td><td style="padding:8px 0;text-align:right;font-weight:600;font-size:14px">${escapeHtml(value)}</td></tr>`;

  let body = `<table role="presentation" width="100%">
${stat('Money in', formatMoney(input.inflowUsdMinor))}
${stat('Money out', formatMoney(input.outflowUsdMinor))}
${stat('Net', formatMoney(input.netUsdMinor))}
${stat('Cash on hand', formatMoney(input.totalCashUsdMinor))}
${stat('Runway', formatMonths(input.runwayMonths))}
${stat('Break-even gap', input.breakEvenGapUsdMinor > 0 ? formatMoney(input.breakEvenGapUsdMinor) : 'Covered')}
</table>`;

  if (input.needsAttention.length) {
    body += `<h2 style="margin:20px 0 8px;font-size:14px">Needs attention</h2><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7">${input.needsAttention
      .map((i) => `<li>${escapeHtml(i)}</li>`)
      .join('')}</ul>`;
  }
  return shell(title, body, input.appUrl, 'digest');
}

// ─── Small helpers ──────────────────────────────────────────────────────────

export function humanize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
