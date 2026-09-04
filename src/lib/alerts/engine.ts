/**
 * Alert rule engine - Spec section 4, MVP Plan Day 4.
 *
 * Flow: a transaction lands -> rules are matched -> ONE alert is composed ->
 * it fans out to the channels the matched rules asked for -> a notification row
 * is written per channel with its delivery result.
 *
 * The "one alert, union of channels" shape matters. A USD 8,000 payroll run
 * matches both "money out - any amount" (Slack + email, info) and "unusually
 * large outflow" (Slack + email + SMS, warning). Firing both rules separately
 * would send the CEO the same payment twice on Slack. Instead the alert
 * inherits the highest severity and the union of channels: one Slack message,
 * one email, one SMS.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AlertRule,
  AlertSeverity,
  FinancialAccount,
  NotificationChannel,
  Transaction,
  TransactionWithContext,
} from '@/lib/types';
import {
  computeSnapshot,
  countsTowardPnl,
  usdMinorOf,
  type UsdRateMap,
} from '@/lib/calc/engine';
import {
  addDays,
  currentMonthRange,
  daysBetween,
  formatDayLabel,
  today,
  trailingDays,
  type ISODate,
} from '@/lib/dates';
import { formatMoney, formatMonths, formatPercent } from '@/lib/money';
import {
  formatDigest,
  formatThresholdAlert,
  formatTransactionAlert,
  humanize,
  type FormattedAlert,
} from '@/lib/alerts/format';
import { channelConfigured, deliver } from '@/lib/alerts/channels';
import { loadUsdRates } from '@/lib/fx';
import { alertable, describeSandboxed, sandboxSources } from '@/lib/alerts/sandbox';
import {
  agingBucket,
  type Obligation,
} from '@/lib/calc/obligations';
import {
  computeBudgetStatus,
  type BudgetRow,
  type BudgetStatus,
  type ScopeContext as BudgetScopeContext,
} from '@/lib/calc/budgets';
import {
  detectRecurringCharges,
  type Cadence,
  type RecurringCharge,
} from '@/lib/subscriptions';

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  digest: 0,
  info: 1,
  warning: 2,
  critical: 3,
};

export interface AlertPlan {
  severity: AlertSeverity;
  channels: NotificationChannel[];
  ruleIds: string[];
  ruleNames: string[];
}

/**
 * Pure rule matching. Exported separately from the delivery code so the routing
 * decisions can be unit tested without a database or a Slack workspace.
 */
export function selectAlertPlan(
  txn: Pick<Transaction, 'direction'>,
  usdMinor: number,
  rules: AlertRule[],
): AlertPlan | null {
  const matched: AlertRule[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    switch (rule.type) {
      case 'money_in':
        if (txn.direction === 'inflow' && usdMinor >= (rule.threshold_minor ?? 0)) matched.push(rule);
        break;
      case 'money_out':
        if (txn.direction === 'outflow' && usdMinor >= (rule.threshold_minor ?? 0)) matched.push(rule);
        break;
      case 'large_outflow':
        if (
          txn.direction === 'outflow' &&
          rule.threshold_minor !== null &&
          usdMinor >= rule.threshold_minor
        ) {
          matched.push(rule);
        }
        break;
      default:
        break; // state-based rules are handled by runThresholdAlerts
    }
  }

  if (matched.length === 0) return null;

  const channels = new Set<NotificationChannel>();
  let severity: AlertSeverity = 'info';
  for (const rule of matched) {
    for (const c of rule.channels) channels.add(c);
    if (SEVERITY_ORDER[rule.severity] > SEVERITY_ORDER[severity]) severity = rule.severity;
  }
  // Every alert is also readable in-app (spec section 4 lists in-app alerts).
  channels.add('in_app');

  return {
    severity,
    channels: [...channels],
    ruleIds: matched.map((r) => r.id),
    ruleNames: matched.map((r) => r.name),
  };
}

// ─── Delivery ───────────────────────────────────────────────────────────────

export interface DispatchSummary {
  transactionsAlerted: number;
  /** Historical rows marked as seen without alerting. */
  suppressedAsBackfill: number;
  /**
   * Rows from an integration pointed at a test environment.
   *
   * Counted rather than silently dropped: "0 sent" and "0 sent, 25
   * suppressed because QuickBooks is in sandbox" are different situations,
   * and only one of them means the alerting is broken.
   */
  suppressedAsSandbox: number;
  notificationsSent: number;
  notificationsFailed: number;
  notificationsSkipped: number;
  errors: string[];
}

const emptySummary = (): DispatchSummary => ({
  transactionsAlerted: 0,
  suppressedAsBackfill: 0,
  suppressedAsSandbox: 0,
  notificationsSent: 0,
  notificationsFailed: 0,
  notificationsSkipped: 0,
  errors: [],
});

/** PostgREST reports an unknown column as PGRST204 with the name in the text. */
function isMissingColumn(message: string, column: string): boolean {
  return (
    message.includes(`'${column}' column`) ||
    (message.includes(column) && /could not find|does not exist|schema cache/i.test(message))
  );
}

/**
 * How old a transaction may be and still be worth announcing.
 *
 * The first sync of any source backfills roughly six months. Without a horizon
 * the engine treats every one of those rows as news and pages the CEO hundreds
 * of times, in one burst, about money that moved in March - on the very first
 * connection, which is the worst possible moment to make the alert channel
 * feel like noise.
 *
 * Older rows are still ingested, still counted in every total, and still
 * visible; they are simply marked as seen rather than announced.
 */
function alertMaxAgeDays(): number {
  const raw = Number(process.env.ALERT_MAX_AGE_DAYS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';
}

async function persistAndDeliver(
  db: SupabaseClient,
  alert: FormattedAlert,
  plan: { channels: NotificationChannel[]; severity: AlertSeverity; ruleId: string | null },
  transactionId: string | null,
  summary: DispatchSummary,
  routing: { slackChannel?: string | null } = {},
  context?: Record<string, unknown>,
): Promise<void> {
  for (const channel of plan.channels) {
    const result = channelConfigured(channel)
      ? await deliver(channel, alert, routing)
      : { channel, ok: false, skipped: true, error: `${channel} not configured` };

    if (result.ok) summary.notificationsSent++;
    else if (result.skipped) summary.notificationsSkipped++;
    else {
      summary.notificationsFailed++;
      summary.errors.push(`${channel}: ${result.error}`);
    }

    const row = {
      alert_rule_id: plan.ruleId,
      transaction_id: transactionId,
      channel,
      severity: plan.severity,
      title: alert.title,
      body: alert.text,
      status: result.ok ? 'sent' : result.skipped ? 'skipped' : 'failed',
      error: result.error ?? null,
      sent_at: result.ok ? new Date().toISOString() : null,
    };

    // `context` arrives with migration 0004. A deploy can outrun a migration,
    // and the cost of getting that wrong here is total: every notification
    // insert fails, so no alert is ever recorded OR delivered. Falling back to
    // the pre-0004 shape keeps alerting alive on an older schema; the only thing
    // lost is the snapshot that makes the log readable after a transaction is
    // deleted.
    const { error } = await db.from('notifications').insert({ ...row, context: context ?? {} });

    if (error && isMissingColumn(error.message, 'context')) {
      const retry = await db.from('notifications').insert(row);
      if (retry.error) summary.errors.push(`notification insert: ${retry.error.message}`);
      else summary.errors.push('notifications.context is missing — apply migration 0004.');
    } else if (error) {
      summary.errors.push(`notification insert: ${error.message}`);
    }
  }
}

/**
 * The every-dollar pass. Picks up every transaction the alert engine has not
 * seen yet (`alerted_at is null`) and fires.
 *
 * `alerted_at` is stamped whether or not delivery succeeded, so a Slack outage
 * cannot turn into the same 400 alerts replaying on the next cron tick. Failed
 * deliveries stay visible as failed notification rows.
 */
export async function runTransactionAlerts(
  db: SupabaseClient,
  options: { limit?: number; asOf?: ISODate; transactionIds?: string[] } = {},
): Promise<DispatchSummary> {
  const summary = emptySummary();
  const limit = options.limit ?? 50;
  const asOf = options.asOf ?? today();

  // `transactionIds` narrows the run to specific rows. The end-to-end test uses
  // it so pressing the button fires exactly the transaction just created, and
  // never a backlog of unrelated ones that happen to be unalerted.
  let query = db
    .from('transactions')
    .select('*, account:financial_accounts(id,name,currency,type), counterparty:counterparties(id,name,type)');

  query = options.transactionIds?.length
    ? query.in('id', options.transactionIds)
    : query.is('alerted_at', null);

  const { data: pending, error: pendingError } = await query
    .order('txn_date', { ascending: false })
    .limit(limit);

  if (pendingError) {
    summary.errors.push(`load pending: ${pendingError.message}`);
    return summary;
  }
  if (!pending?.length) return summary;

  /*
   * Nothing from a test environment wakes anybody up.
   *
   * The rows stay in the ledger and on every page; this decides only who gets
   * a message. See `sandbox.ts` for why — twelve Slack alerts about QuickBooks
   * sandbox invoices is how a CEO learns to ignore the channel.
   */
  const sandboxed = sandboxSources();
  const alertablePending = (pending as TransactionWithContext[]).filter((t) =>
    alertable(t, sandboxed),
  );
  summary.suppressedAsSandbox += pending.length - alertablePending.length;
  if (alertablePending.length === 0) return summary;

  const [{ data: rules }, { data: accounts }, { data: allTxns }] = await Promise.all([
    db.from('alert_rules').select('*').eq('enabled', true),
    db.from('financial_accounts').select('*'),
    db.from('transactions').select('*').gte('txn_date', trailingDays(asOf, 120).from),
  ]);

  const rates = await loadUsdRates(db, asOf);
  const snapshot = computeSnapshot(
    (accounts ?? []) as FinancialAccount[],
    (allTxns ?? []) as Transaction[],
    asOf,
    rates,
  );

  const monthRange = currentMonthRange(asOf);
  const categorySpend = new Map<string, number>();
  for (const t of (allTxns ?? []) as Transaction[]) {
    if (!countsTowardPnl(t) || t.direction !== 'outflow') continue;
    if (t.txn_date < monthRange.from || t.txn_date > monthRange.to) continue;
    const key = t.category ?? 'uncategorized';
    categorySpend.set(key, (categorySpend.get(key) ?? 0) + usdMinorOf(t, rates));
  }

  // An explicit id list means somebody asked for these specific rows - the
  // end-to-end test, a manual replay - so the age horizon does not apply.
  const horizon = options.transactionIds?.length
    ? null
    : trailingDays(asOf, alertMaxAgeDays() + 1).from;

  // The filtered list, not `pending` — otherwise the suppression above would
  // be counted and then ignored.
  for (const row of alertablePending) {
    if (horizon && row.txn_date < horizon) {
      const { error } = await db
        .from('transactions')
        .update({ alerted_at: new Date().toISOString() })
        .eq('id', row.id);
      if (error) summary.errors.push(`stamp backfill: ${error.message}`);
      else summary.suppressedAsBackfill++;
      continue;
    }

    const usdMinor = usdMinorOf(row, rates);
    const plan = selectAlertPlan(row, usdMinor, (rules ?? []) as AlertRule[]);

    if (plan) {
      const alert = formatTransactionAlert(
        row,
        {
          totalCashUsdMinor: snapshot.cash.totalUsdMinor,
          runwayMonths: snapshot.runway.headlineMonths,
          categorySpendMtdUsdMinor: categorySpend.get(row.category ?? 'uncategorized'),
          appUrl: appUrl(),
        },
        plan.severity,
      );

      await persistAndDeliver(
        db,
        alert,
        { channels: plan.channels, severity: plan.severity, ruleId: plan.ruleIds[0] ?? null },
        row.id,
        summary,
        { slackChannel: routeSlackChannel(plan.severity) },
        {
          account: row.account?.name ?? null,
          counterparty: row.counterparty?.name ?? null,
          amount_minor: row.amount_minor,
          currency: row.currency,
          direction: row.direction,
          txn_date: row.txn_date,
          source_system: row.source_system,
        },
      );
      summary.transactionsAlerted++;
    }

    const { error } = await db
      .from('transactions')
      .update({ alerted_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) summary.errors.push(`stamp alerted_at: ${error.message}`);
  }

  return summary;
}

/**
 * State-based alerts: runway and account balance. These describe a condition
 * rather than an event, so they need a cooldown - without one, a company under
 * its runway floor would page the CEO every five minutes, forever.
 */
export async function runThresholdAlerts(
  db: SupabaseClient,
  options: { asOf?: ISODate; cooldownHours?: number } = {},
): Promise<DispatchSummary> {
  const summary = emptySummary();
  const asOf = options.asOf ?? today();
  const cooldownHours = options.cooldownHours ?? 24;

  const [{ data: rules }, { data: accounts }, { data: txns }] = await Promise.all([
    db.from('alert_rules').select('*').eq('enabled', true),
    db.from('financial_accounts').select('*'),
    db.from('transactions').select('*').gte('txn_date', trailingDays(asOf, 400).from),
  ]);

  const rates = await loadUsdRates(db, asOf);
  const accountList = (accounts ?? []) as FinancialAccount[];
  const snapshot = computeSnapshot(accountList, (txns ?? []) as Transaction[], asOf, rates);
  const since = new Date(Date.now() - cooldownHours * 3600_000).toISOString();

  for (const rule of (rules ?? []) as AlertRule[]) {
    if (rule.type !== 'low_runway' && rule.type !== 'low_balance') continue;

    const { count } = await db
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('alert_rule_id', rule.id)
      .eq('status', 'sent')
      .gte('created_at', since);
    if ((count ?? 0) > 0) continue;

    let alert: FormattedAlert | null = null;

    if (rule.type === 'low_runway') {
      const months = snapshot.runway.headlineMonths;
      const floor = rule.threshold_number === null ? 6 : Number(rule.threshold_number);
      if (months !== null && months < floor && snapshot.burn.hasEnoughData) {
        alert = formatThresholdAlert({
          kind: 'low_runway',
          headline: `Runway is ${formatMonths(months)} — below the ${floor}-month floor`,
          detail: `Cash on hand ${formatMoney(snapshot.cash.totalUsdMinor)} against average monthly net burn of ${formatMoney(snapshot.burn.netMonthlyBurnUsdMinor)}. Break-even revenue still needed this month: ${formatMoney(snapshot.breakEven.gapUsdMinor)}.`,
          url: `${appUrl()}/`,
          severity: rule.severity,
        });
      }
    } else {
      const floor = rule.threshold_minor ?? 0;
      const low = snapshot.cash.byAccount.filter(
        (b) => b.account.include_in_cash && b.balanceUsdMinor < floor,
      );
      if (low.length) {
        const names = low
          .map((b) => `${b.account.name} (${formatMoney(b.balanceMinor, b.account.currency)})`)
          .join(', ');
        alert = formatThresholdAlert({
          kind: 'low_balance',
          headline: `${low.length} account${low.length > 1 ? 's' : ''} below ${formatMoney(floor)}`,
          detail: `${names}. Total cash across all accounts: ${formatMoney(snapshot.cash.totalUsdMinor)}.`,
          url: `${appUrl()}/accounts`,
          severity: rule.severity,
        });
      }
    }

    if (!alert) continue;
    await persistAndDeliver(
      db,
      alert,
      { channels: [...new Set([...rule.channels, 'in_app' as NotificationChannel])], severity: rule.severity, ruleId: rule.id },
      null,
      summary,
      { slackChannel: routeSlackChannel(rule.severity) },
    );
  }

  return summary;
}

/**
 * Price-increase alerts - Spec section 8.
 *
 * The detector has always found these; nothing announced them. A price rise
 * nobody opens a page to discover is a price rise that just gets paid, every
 * month, until someone happens to look.
 *
 * TWO THINGS THAT SHAPE THIS:
 *
 *   1. It fires once per vendor per price change, and the dedupe key is the
 *      vendor plus the date the price moved - recorded in `notifications.context`.
 *      The obvious alternative, the 24-hour cooldown the other threshold rules
 *      use, would re-announce the same increase every single day for as long as
 *      the vendor keeps billing the new amount. That is how people learn to
 *      ignore a channel.
 *
 *   2. Both floors must be cleared: the percentage AND the annual cost. A 40%
 *      rise on a $4/mo tool is $19 a year, and a 3% rise on a payroll bill is
 *      not a price anyone chose. Either floor alone lets one of those through.
 */
export async function runPriceIncreaseAlerts(
  db: SupabaseClient,
  options: { asOf?: ISODate } = {},
): Promise<DispatchSummary> {
  const summary = emptySummary();
  const asOf = options.asOf ?? today();

  const { data: rules } = await db
    .from('alert_rules')
    .select('*')
    .eq('enabled', true)
    .eq('type', 'price_increase');

  const rule = (rules ?? [])[0] as AlertRule | undefined;
  if (!rule) return summary;

  const minRise = rule.threshold_number === null ? 0.1 : Number(rule.threshold_number);
  const minAnnualUsdMinor = rule.threshold_minor ?? 0;

  const { charges } = await loadRecurringChargesFor(db, asOf);

  // Only announcements that have already gone out matter, so a failed delivery
  // is retried on the next run rather than silently swallowed.
  const { data: alreadySent } = await db
    .from('notifications')
    .select('context')
    .eq('alert_rule_id', rule.id)
    .eq('status', 'sent');

  const announced = new Set(
    (alreadySent ?? [])
      .map((n) => (n as { context?: { priceChangeKey?: string } }).context?.priceChangeKey)
      .filter(Boolean) as string[],
  );

  for (const charge of charges) {
    if (charge.priceChange === null || charge.priceChange < minRise) continue;
    if (charge.previousAmountUsdMinor === null || charge.priceChangedOn === null) continue;

    const extraPerYear = annualIncreaseOf(charge);
    if (extraPerYear < minAnnualUsdMinor) continue;

    const key = `${charge.vendorKey}@${charge.priceChangedOn}`;
    if (announced.has(key)) continue;

    const alert = formatThresholdAlert({
      kind: 'price_increase',
      headline: `${charge.vendorName} raised its price ${formatPercent(charge.priceChange, 0)}`,
      detail:
        `${formatMoney(charge.previousAmountUsdMinor)} to ${formatMoney(charge.currentAmountUsdMinor)} ` +
        `per ${cadenceNoun(charge.cadence)}, first billed at the new price on ${charge.priceChangedOn}. ` +
        `That is ${formatMoney(extraPerYear)} a year more than before, taking this charge to ` +
        `${formatMoney(charge.annualisedUsdMinor)} a year.`,
      url: `${appUrl()}/subscriptions`,
      severity: rule.severity,
    });

    await persistAndDeliver(
      db,
      alert,
      {
        channels: [...new Set([...rule.channels, 'in_app' as NotificationChannel])],
        severity: rule.severity,
        ruleId: rule.id,
      },
      null,
      summary,
      { slackChannel: routeSlackChannel(rule.severity) },
      {
        priceChangeKey: key,
        vendorName: charge.vendorName,
        previousAmountUsdMinor: charge.previousAmountUsdMinor,
        currentAmountUsdMinor: charge.currentAmountUsdMinor,
        annualIncreaseUsdMinor: extraPerYear,
      },
    );
    announced.add(key);
  }

  return summary;
}

/**
 * The extra annual cost of the most recent price rise.
 *
 * Both amounts are annualised on the SAME cadence, so this is the price move
 * and nothing else. Comparing a new price against an old annual total would
 * fold any change in billing frequency into a figure labelled "price".
 */
function annualIncreaseOf(charge: RecurringCharge): number {
  if (charge.previousAmountUsdMinor === null || charge.currentAmountUsdMinor === 0) return 0;
  const perYear = charge.annualisedUsdMinor / charge.currentAmountUsdMinor;
  return Math.round((charge.currentAmountUsdMinor - charge.previousAmountUsdMinor) * perYear);
}

function cadenceNoun(cadence: Cadence): string {
  return { weekly: 'week', monthly: 'month', quarterly: 'quarter', annual: 'year', irregular: 'billing period' }[
    cadence
  ];
}

/**
 * The same history window the /subscriptions page reads, loaded here rather
 * than imported from `@/lib/data` - that module pulls in the page-level Supabase
 * helpers, and the scheduler calls this with a service-role client.
 */
async function loadRecurringChargesFor(
  db: SupabaseClient,
  asOf: ISODate,
): Promise<{ charges: RecurringCharge[] }> {
  const [{ data }, rates] = await Promise.all([
    db
      .from('transactions')
      .select('*, counterparty:counterparties(id,name,type)')
      .eq('direction', 'outflow')
      .gte('txn_date', addDays(asOf, -1_100))
      .lte('txn_date', asOf)
      .limit(20_000),
    loadUsdRates(db, asOf),
  ]);

  return {
    charges: detectRecurringCharges((data ?? []) as Transaction[], { asOf, rates }),
  };
}

/**
 * Overspend alerts - Spec section 19, "alerts before overspend occurs".
 *
 * The word BEFORE is the requirement. An alert that fires once a budget is
 * already over is a notification, not a warning - by then the money is gone.
 * So this fires on the PROJECTION, which means it can be wrong, and everything
 * below is about not being wrong often enough to be ignored.
 *
 *   - It will not fire on a projection it does not believe. Below the
 *     confidence floor the run rate is arithmetic on almost no evidence.
 *   - It fires once per budget per period, deduped through
 *     `notifications.context`. A daily sweep re-announcing the same overspend
 *     every morning is how a channel becomes noise - the same reasoning as the
 *     price-increase alerts (decision 46).
 *   - It fires again, once, when the budget actually goes over. That is a
 *     different fact from "heading over" and worth saying.
 */
export async function runBudgetAlerts(
  db: SupabaseClient,
  options: { asOf?: ISODate } = {},
): Promise<DispatchSummary> {
  const summary = emptySummary();
  const asOf = options.asOf ?? today();

  const { data: rules } = await db
    .from('alert_rules')
    .select('*')
    .eq('enabled', true)
    .eq('type', 'budget_overspend');

  const rule = (rules ?? [])[0] as AlertRule | undefined;
  if (!rule) return summary;

  // The share of budget the projection has to reach. Default 1: a projection
  // that lands exactly on budget is not yet a problem.
  const threshold = rule.threshold_number === null ? 1 : Number(rule.threshold_number);

  const board = await loadBudgetBoardForAlerts(db, asOf);

  const { data: alreadySent } = await db
    .from('notifications')
    .select('context')
    .eq('alert_rule_id', rule.id)
    .eq('status', 'sent');

  const announced = new Set(
    (alreadySent ?? [])
      .map((n) => (n as { context?: { budgetKey?: string } }).context?.budgetKey)
      .filter(Boolean) as string[],
  );

  for (const status of board) {
    // A closed period cannot be warned about. Whatever happened, happened.
    if (status.progress.hasEnded) continue;

    const overBy = status.actualUsdMinor - status.budgetUsdMinor;
    const projectedRatio =
      status.budgetUsdMinor > 0 ? status.projectedFinalUsdMinor / status.budgetUsdMinor : 0;

    const stage = status.overspent
      ? 'over'
      : projectedRatio >= threshold && status.projectionConfidence >= MIN_PROJECTION_CONFIDENCE
        ? 'heading-over'
        : null;

    if (!stage) continue;

    // Keyed by stage as well as by budget and period, so the "it has actually
    // gone over now" alert is not suppressed by the earlier warning.
    const key = `${status.budget.id}@${status.periodStart}:${stage}`;
    if (announced.has(key)) continue;

    const daysLeft = status.progress.daysTotal - status.progress.daysElapsed;

    const headline =
      stage === 'over'
        ? `${status.budget.name} is over budget by ${formatMoney(overBy)}`
        : `${status.budget.name} is on pace to go over budget`;

    const detail =
      stage === 'over'
        ? `${formatMoney(status.actualUsdMinor)} spent against a ${formatMoney(
            status.budgetUsdMinor,
          )} budget, with ${daysLeft} day${daysLeft === 1 ? '' : 's'} still to run.`
        : `${formatMoney(status.actualUsdMinor)} spent on day ${status.progress.daysElapsed} of ` +
          `${status.progress.daysTotal}. At this pace the period ends at ` +
          `${formatMoney(status.projectedFinalUsdMinor)} against a ` +
          `${formatMoney(status.budgetUsdMinor)} budget, ` +
          `${formatPercent(projectedRatio - 1, 0)} over. That is a projection from ` +
          `${status.transactionCount} payments, not a certainty.`;

    await persistAndDeliver(
      db,
      formatThresholdAlert({
        kind: 'budget_overspend',
        headline,
        detail,
        url: `${appUrl()}/budgets`,
        severity: rule.severity,
      }),
      {
        channels: [...new Set([...rule.channels, 'in_app' as NotificationChannel])],
        severity: rule.severity,
        ruleId: rule.id,
      },
      null,
      summary,
      { slackChannel: routeSlackChannel(rule.severity) },
      {
        budgetKey: key,
        budgetName: status.budget.name,
        budgetUsdMinor: status.budgetUsdMinor,
        actualUsdMinor: status.actualUsdMinor,
        projectedFinalUsdMinor: status.projectedFinalUsdMinor,
        projectionConfidence: status.projectionConfidence,
      },
    );
    announced.add(key);
  }

  return summary;
}

/**
 * Below this the run rate is extrapolating from almost nothing.
 *
 * Even money. An alert that is wrong half the time is already borderline; one
 * that is wrong more often trains its reader to dismiss the channel, and the
 * real overspend goes with it.
 */
const MIN_PROJECTION_CONFIDENCE = 0.5;

/**
 * The same figures the page shows, loaded here rather than imported from
 * `@/lib/data` - that module pulls in the page-level Supabase helpers, and the
 * scheduler calls this with a service-role client.
 */
async function loadBudgetBoardForAlerts(
  db: SupabaseClient,
  asOf: ISODate,
): Promise<BudgetStatus[]> {
  const [budgetsRes, txnRes, projectsRes, accountsRes, rates] = await Promise.all([
    db.from('budgets').select('*').eq('is_active', true),
    db
      .from('transactions')
      .select('*')
      .gte('txn_date', addDays(asOf, -450))
      .lte('txn_date', asOf)
      .limit(20_000),
    db.from('projects').select('id,business_unit_id,client_id'),
    db.from('financial_accounts').select('id,company_id'),
    loadUsdRates(db, asOf),
  ]);

  const context: BudgetScopeContext = {
    projectMeta: new Map(
      (
        (projectsRes.data ?? []) as Array<{
          id: string;
          business_unit_id: string | null;
          client_id: string | null;
        }>
      ).map((p) => [p.id, { businessUnitId: p.business_unit_id, clientId: p.client_id }]),
    ),
    companyOfAccount: new Map(
      ((accountsRes.data ?? []) as Array<{ id: string; company_id: string | null }>).map((a) => [
        a.id,
        a.company_id,
      ]),
    ),
  };

  const transactions = (txnRes.data ?? []) as Array<Transaction & { project_id?: string | null }>;
  return ((budgetsRes.data ?? []) as BudgetRow[]).map((b) =>
    computeBudgetStatus(b, transactions, asOf, context, rates),
  );
}

/**
 * Overdue receivables and upcoming obligations - Spec sections 17 and 18.
 *
 * Section 17 asks for alerts on "overdue invoices and large upcoming
 * receivables"; section 18 for visibility of commitments "before money leaves
 * the bank". Two different alerts, one sweep.
 *
 * BOTH DEDUPE BY EVENT, not by a cooldown. An invoice that is 40 days overdue
 * is still 40 days overdue tomorrow, and a daily reminder about it is how a
 * channel stops being read. Each fires once per item per aging bucket, so
 * crossing from 30 days to 60 says something new and the days in between say
 * nothing.
 */
export async function runObligationAlerts(
  db: SupabaseClient,
  options: { asOf?: ISODate } = {},
): Promise<DispatchSummary> {
  const summary = emptySummary();
  const asOf = options.asOf ?? today();

  const { data: ruleRows } = await db
    .from('alert_rules')
    .select('*')
    .eq('enabled', true)
    .in('type', ['overdue_receivable', 'upcoming_obligation']);

  const rules = (ruleRows ?? []) as AlertRule[];
  const overdueRule = rules.find((r) => r.type === 'overdue_receivable');
  const upcomingRule = rules.find((r) => r.type === 'upcoming_obligation');
  if (!overdueRule && !upcomingRule) return summary;

  const [{ data: obligationRows }, rates] = await Promise.all([
    db.from('obligations').select('*').in('status', ['open', 'draft']),
    loadUsdRates(db, asOf),
  ]);
  /*
   * The same rule as the transaction alerts, and the reason this file changed.
   *
   * QuickBooks' sandbox company ships with 31 invoices, most of them long
   * overdue and none of them ever going to be paid. Importing them was correct;
   * paging AHN about them was not. Twelve Slack messages went out before this
   * existed, and more arrived each day as the fake receivables aged.
   */
  const sandboxedSources = sandboxSources();
  const allObligations = (obligationRows ?? []) as Obligation[];
  const obligations = allObligations.filter((o) => alertable(o, sandboxedSources));
  summary.suppressedAsSandbox += allObligations.length - obligations.length;

  const ruleIds = rules.map((r) => r.id);
  const { data: alreadySent } = await db
    .from('notifications')
    .select('context')
    .in('alert_rule_id', ruleIds)
    .eq('status', 'sent');

  const announced = new Set(
    (alreadySent ?? [])
      .map((n) => (n as { context?: { obligationKey?: string } }).context?.obligationKey)
      .filter(Boolean) as string[],
  );

  const send = async (
    rule: AlertRule,
    key: string,
    headline: string,
    detail: string,
    extra: Record<string, unknown>,
  ) => {
    if (announced.has(key)) return;
    await persistAndDeliver(
      db,
      formatThresholdAlert({
        kind: 'obligation',
        headline,
        detail,
        url: `${appUrl()}/obligations`,
        severity: rule.severity,
      }),
      {
        channels: [...new Set([...rule.channels, 'in_app' as NotificationChannel])],
        severity: rule.severity,
        ruleId: rule.id,
      },
      null,
      summary,
      { slackChannel: routeSlackChannel(rule.severity) },
      { obligationKey: key, ...extra },
    );
    announced.add(key);
  };

  // ── Overdue receivables (spec 17) ──
  if (overdueRule) {
    const floor = overdueRule.threshold_minor ?? 0;

    for (const o of obligations) {
      if (o.direction !== 'inflow') continue;
      const bucket = agingBucket(o.due_on, asOf);
      // Not overdue yet, so there is nothing to chase.
      if (bucket === 'not_due' || bucket === 'current') continue;

      const usd = obligationUsdMinor(o, rates);
      if (usd < floor) continue;

      const daysOver = daysBetween(o.due_on, asOf);
      await send(
        overdueRule,
        // Keyed by bucket: crossing 30 days into 60 is news, the days between
        // are the same fact repeated.
        `${o.id}:${bucket}`,
        `${o.counterparty_name ?? 'An invoice'} is ${daysOver} days overdue`,
        `${formatMoney(usd)} was due on ${o.due_on}${o.reference ? ` (${o.reference})` : ''}. ` +
          `${o.description ?? 'No description recorded'}.`,
        { obligationId: o.id, amountUsdMinor: usd, daysOverdue: daysOver },
      );
    }
  }

  // ── Large upcoming commitments (spec 17 and 18) ──
  if (upcomingRule) {
    const floor = upcomingRule.threshold_minor ?? 0;
    const horizon = addDays(asOf, UPCOMING_HORIZON_DAYS);

    for (const o of obligations) {
      if (o.due_on < asOf || o.due_on > horizon) continue;

      const usd = obligationUsdMinor(o, rates);
      if (usd < floor) continue;

      const daysAway = daysBetween(asOf, o.due_on);
      const isPayable = o.direction === 'outflow';

      await send(
        upcomingRule,
        `${o.id}:upcoming`,
        isPayable
          ? `${formatMoney(usd)} due to ${o.counterparty_name ?? 'a supplier'} in ${daysAway} days`
          : `${formatMoney(usd)} expected from ${o.counterparty_name ?? 'a client'} in ${daysAway} days`,
        `${o.description ?? 'No description recorded'}. Due ${o.due_on}.` +
          (isPayable
            ? ' Cash after commitments is on the Owed & owing page.'
            : ' Expected receipts are deliberately excluded from the cash figure there.'),
        { obligationId: o.id, amountUsdMinor: usd, daysAway },
      );
    }
  }

  return summary;
}

/** How far ahead a commitment is worth mentioning. */
const UPCOMING_HORIZON_DAYS = 14;

function obligationUsdMinor(o: Obligation, rates: UsdRateMap): number {
  const code = o.currency.toUpperCase();
  if (code === 'USD') return o.amount_minor;
  const rate = rates[code];
  if (rate === undefined) return 0;
  return Math.round(o.amount_minor * rate * 100);
}

/** Daily / weekly CFO digest (MVP Plan section 7). */
export async function runDigest(
  db: SupabaseClient,
  period: 'daily' | 'weekly',
  options: { asOf?: ISODate } = {},
): Promise<DispatchSummary> {
  const summary = emptySummary();
  const asOf = options.asOf ?? today();
  const window = trailingDays(asOf, period === 'daily' ? 1 : 7);

  const [{ data: rules }, { data: accounts }, { data: txns }] = await Promise.all([
    db.from('alert_rules').select('*').eq('enabled', true).eq('type', `${period}_summary`),
    db.from('financial_accounts').select('*'),
    db
      .from('transactions')
      .select('*, account:financial_accounts(id,name,currency,type), counterparty:counterparties(id,name,type)')
      .gte('txn_date', trailingDays(asOf, 400).from),
  ]);

  const rule = (rules ?? [])[0] as AlertRule | undefined;
  if (!rule) return summary;

  const rates = await loadUsdRates(db, asOf);
  const all = (txns ?? []) as TransactionWithContext[];
  const snapshot = computeSnapshot(
    (accounts ?? []) as FinancialAccount[],
    all as Transaction[],
    asOf,
    rates,
  );

  const inWindow = all.filter(
    (t) => countsTowardPnl(t) && t.txn_date >= window.from && t.txn_date <= window.to,
  );
  const inflow = inWindow
    .filter((t) => t.direction === 'inflow')
    .reduce((sum, t) => sum + usdMinorOf(t, rates), 0);
  const outflow = inWindow
    .filter((t) => t.direction === 'outflow')
    .reduce((sum, t) => sum + usdMinorOf(t, rates), 0);

  const topOutflows = inWindow
    .filter((t) => t.direction === 'outflow')
    .sort((a, b) => usdMinorOf(b, rates) - usdMinorOf(a, rates))
    .slice(0, 5)
    .map((t) => ({
      label: t.counterparty?.name ?? t.description ?? humanize(t.category ?? 'uncategorized'),
      amountUsdMinor: usdMinorOf(t, rates),
      date: t.txn_date,
    }));

  const alert = formatDigest({
    period,
    periodLabel:
      period === 'daily'
        ? formatDayLabel(window.to)
        : `${formatDayLabel(window.from)} – ${formatDayLabel(window.to)}`,
    inflowUsdMinor: inflow,
    outflowUsdMinor: outflow,
    netUsdMinor: inflow - outflow,
    txnCount: inWindow.length,
    totalCashUsdMinor: snapshot.cash.totalUsdMinor,
    runwayMonths: snapshot.runway.headlineMonths,
    breakEvenGapUsdMinor: snapshot.breakEven.gapUsdMinor,
    topOutflows,
    needsAttention: buildNeedsAttention(snapshot, all),
    appUrl: appUrl(),
  });

  await persistAndDeliver(
    db,
    alert,
    { channels: [...new Set([...rule.channels, 'in_app' as NotificationChannel])], severity: 'digest', ruleId: rule.id },
    null,
    summary,
    { slackChannel: routeSlackChannel('digest') },
  );

  return summary;
}

/**
 * The "what needs attention right now" list on the home screen and in digests
 * (spec section 21). Deterministic checks only - the AI CFO layer of spec
 * section 20 will add interpretation on top in Phase 3.
 */
export function buildNeedsAttention(
  snapshot: ReturnType<typeof computeSnapshot>,
  transactions: Transaction[],
): string[] {
  const items: string[] = [];

  // Uses the headline figure, which is GROSS runway while the company is
  // cash-positive. Checking net runway would stay silent about a company with
  // 3.5 months of cash simply because last quarter's revenue covered spend.
  const runwayMonths = snapshot.runway.headlineMonths;
  if (runwayMonths !== null && runwayMonths < 6) {
    items.push(
      snapshot.runway.cashPositive
        ? `Cash covers only ${formatMonths(runwayMonths)} if revenue stopped — below the 6-month floor, despite being cash-positive.`
        : `Runway is ${formatMonths(runwayMonths)} — below the 6-month floor.`,
    );
  }
  if (
    snapshot.runway.worstCaseMonths !== null &&
    snapshot.runway.worstCaseMonths < 3 &&
    snapshot.burn.worstMonth
  ) {
    items.push(
      `At the spend of ${snapshot.burn.worstMonth.slice(0, 7)}, the worst month on record, cash would last ${formatMonths(snapshot.runway.worstCaseMonths)}.`,
    );
  }
  if (snapshot.breakEven.gapUsdMinor > 0) {
    items.push(
      `${formatMoney(snapshot.breakEven.gapUsdMinor)} more revenue is needed to break even this month.`,
    );
  }
  if (snapshot.cash.unreconciledAccounts > 0) {
    items.push(
      `${snapshot.cash.unreconciledAccounts} account balance${snapshot.cash.unreconciledAccounts > 1 ? 's do' : ' does'} not match the transactions we hold.`,
    );
  }

  const dupes = transactions.filter((t) => t.reconciliation_status === 'possible_duplicate').length;
  if (dupes > 0) {
    items.push(`${dupes} possible duplicate transaction${dupes > 1 ? 's' : ''} awaiting review.`);
  }

  const uncategorized = transactions.filter(
    (t) => countsTowardPnl(t) && (!t.category || t.category === 'uncategorized'),
  ).length;
  if (uncategorized > 0) {
    items.push(`${uncategorized} transaction${uncategorized > 1 ? 's have' : ' has'} no category.`);
  }

  return items;
}

/**
 * Route by severity so a 3am critical page does not land in the same channel as
 * routine money-in noise (spec section 5: "route different alert types to
 * different Slack channels").
 */
function routeSlackChannel(severity: AlertSeverity): string | null {
  const map: Partial<Record<AlertSeverity, string | undefined>> = {
    critical: process.env.SLACK_CHANNEL_CRITICAL,
    warning: process.env.SLACK_CHANNEL_WARNING,
    digest: process.env.SLACK_CHANNEL_DIGEST,
  };
  return map[severity] ?? process.env.SLACK_DEFAULT_CHANNEL ?? null;
}
