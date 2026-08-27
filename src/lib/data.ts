/**
 * Read helpers shared by the pages.
 *
 * These run through the caller Supabase client, so Row Level Security applies:
 * a viewer loading the dashboard genuinely does not receive payroll rows, they
 * are not merely hidden in the markup.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AlertRule,
  AuditLog,
  FinancialAccount,
  NotificationRow,
  Transaction,
  TransactionWithContext,
} from '@/lib/types';
import { computeSnapshot, type FinancialSnapshot, type UsdRateMap } from '@/lib/calc/engine';
import { loadUsdRates } from '@/lib/fx';
import { addDays, today, type ISODate } from '@/lib/dates';
import {
  detectRecurringCharges,
  summariseSubscriptions,
  type RecurringCharge,
  type SubscriptionSummary,
} from '@/lib/subscriptions';

/** Trailing window the dashboard loads. Covers the 3-month burn plus headroom. */
const SNAPSHOT_WINDOW_DAYS = 400;

const TXN_SELECT =
  '*, account:financial_accounts(id,name,currency,type), counterparty:counterparties(id,name,type)';

export interface DashboardData {
  snapshot: FinancialSnapshot;
  accounts: FinancialAccount[];
  transactions: TransactionWithContext[];
  rates: UsdRateMap;
  asOf: ISODate;
}

export async function loadDashboard(
  db: SupabaseClient,
  asOf: ISODate = today(),
): Promise<DashboardData> {
  const [accountsRes, txnRes, rates] = await Promise.all([
    db.from('financial_accounts').select('*').order('name'),
    db
      .from('transactions')
      .select(TXN_SELECT)
      .gte('txn_date', addDays(asOf, -SNAPSHOT_WINDOW_DAYS))
      .order('txn_date', { ascending: false })
      .limit(10_000),
    loadUsdRates(db, asOf),
  ]);

  const accounts = (accountsRes.data ?? []) as FinancialAccount[];
  const transactions = (txnRes.data ?? []) as TransactionWithContext[];

  return {
    snapshot: computeSnapshot(accounts, transactions as Transaction[], asOf, rates),
    accounts,
    transactions,
    rates,
    asOf,
  };
}

// ─── Transaction list with filters (the drill-down target) ──────────────────

export interface TransactionFilters {
  direction?: 'inflow' | 'outflow';
  accountId?: string;
  category?: string;
  counterpartyId?: string;
  status?: string;
  from?: ISODate;
  to?: ISODate;
  search?: string;
  /** Only rows that count toward P&L (excludes duplicates and transfers). */
  operatingOnly?: boolean;
  uncategorized?: boolean;
  /** Which connector the row came from. */
  source?: string;
  /**
   * Hide rows written by `npm run db:seed`.
   *
   * Demo rows are keyed `demo-%` by the seeder, so they can be told apart from
   * anything a real connector or import produced. Until the demo data is
   * cleared, this is the only way to look at real money on its own.
   */
  excludeDemo?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Applies the filter set to a query.
 *
 * Shared by the row fetch and the totals fetch so the two can never drift. If
 * they did, the drill-down would show one set of rows and a total computed over
 * a different set - which is the exact failure the drill-down exists to rule
 * out.
 */
function applyFilters<T>(query: T, filters: TransactionFilters): T {
  let q = query as never as {
    eq: (c: string, v: unknown) => typeof q;
    gte: (c: string, v: unknown) => typeof q;
    lte: (c: string, v: unknown) => typeof q;
    or: (v: string) => typeof q;
    not: (c: string, op: string, v: string) => typeof q;
    like: (c: string, v: string) => typeof q;
  };

  if (filters.direction) q = q.eq('direction', filters.direction);
  if (filters.accountId) q = q.eq('account_id', filters.accountId);
  if (filters.counterpartyId) q = q.eq('counterparty_id', filters.counterpartyId);
  if (filters.category) q = q.eq('category', filters.category);
  if (filters.status) q = q.eq('reconciliation_status', filters.status);
  if (filters.from) q = q.gte('txn_date', filters.from);
  if (filters.to) q = q.lte('txn_date', filters.to);
  if (filters.search) {
    const term = `%${filters.search.replace(/[%_]/g, '')}%`;
    q = q.or(`description.ilike.${term},notes.ilike.${term}`);
  }
  if (filters.uncategorized) {
    q = q.or('category.is.null,category.eq.uncategorized');
  }
  if (filters.source) q = q.eq('source_system', filters.source);
  if (filters.excludeDemo) q = q.not('external_txn_id', 'like', 'demo-%');
  if (filters.operatingOnly) {
    // Mirrors countsTowardPnl() in the calc engine: what the dashboard totals
    // count is exactly what this drill-down lists.
    q = q
      .eq('is_internal_transfer', false)
      .not('reconciliation_status', 'in', '("possible_duplicate","duplicate_ignored")');
  }
  return q as never as T;
}

export async function loadTransactions(
  db: SupabaseClient,
  filters: TransactionFilters = {},
): Promise<{ rows: TransactionWithContext[]; total: number }> {
  const query = applyFilters(db.from('transactions').select(TXN_SELECT, { count: 'exact' }), filters);

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const { data, count } = await query
    .order('txn_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return { rows: (data ?? []) as TransactionWithContext[], total: count ?? 0 };
}

export interface FilterTotals {
  inflowUsdMinor: number;
  outflowUsdMinor: number;
  netUsdMinor: number;
  count: number;
  /** True when the filter matched more rows than were summed. */
  truncated: boolean;
}

/**
 * Totals across EVERY row the filter matches, not just the page on screen.
 *
 * MVP Plan Day 6 asks that every dashboard number drill down to its source
 * transactions. A page-only total defeats that: click "Spent MTD $64,186" and
 * the first hundred rows add up to something smaller, so the drill-down
 * contradicts the tile it came from instead of confirming it.
 *
 * Only three columns are fetched, so this stays cheap even over a long window.
 */
export async function loadTransactionTotals(
  db: SupabaseClient,
  filters: TransactionFilters = {},
): Promise<FilterTotals> {
  const CAP = 20_000;
  const query = applyFilters(
    db.from('transactions').select('direction,amount_usd_minor,amount_minor,currency'),
    filters,
  );
  const { data } = await query.limit(CAP);

  const rows = (data ?? []) as Array<{
    direction: 'inflow' | 'outflow';
    amount_usd_minor: number | null;
    amount_minor: number;
    currency: string;
  }>;

  let inflow = 0;
  let outflow = 0;
  for (const r of rows) {
    // An unstamped non-USD row contributes zero rather than being counted at
    // face value - the same rule the calc engine uses.
    const usd = r.amount_usd_minor ?? (r.currency === 'USD' ? r.amount_minor : 0);
    if (r.direction === 'inflow') inflow += usd;
    else outflow += usd;
  }

  return {
    inflowUsdMinor: inflow,
    outflowUsdMinor: outflow,
    netUsdMinor: inflow - outflow,
    count: rows.length,
    truncated: rows.length >= CAP,
  };
}

export async function loadTransaction(
  db: SupabaseClient,
  id: string,
): Promise<TransactionWithContext | null> {
  const { data } = await db.from('transactions').select(TXN_SELECT).eq('id', id).maybeSingle();
  return (data as TransactionWithContext) ?? null;
}

export async function loadAuditForRecord(
  db: SupabaseClient,
  tableName: string,
  recordId: string,
): Promise<AuditLog[]> {
  const { data } = await db
    .from('audit_logs')
    .select('*')
    .eq('table_name', tableName)
    .eq('record_id', recordId)
    .order('changed_at', { ascending: false });
  return (data ?? []) as AuditLog[];
}

export async function loadAlertRules(db: SupabaseClient): Promise<AlertRule[]> {
  const { data } = await db.from('alert_rules').select('*').order('type');
  return (data ?? []) as AlertRule[];
}

export async function loadNotifications(
  db: SupabaseClient,
  limit = 60,
): Promise<NotificationRow[]> {
  const { data } = await db
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []) as NotificationRow[];
}

/** Distinct categories present in the data, for filter dropdowns. */
export async function loadCategories(db: SupabaseClient): Promise<string[]> {
  const { data } = await db
    .from('transactions')
    .select('category')
    .not('category', 'is', null)
    .limit(5000);
  const set = new Set<string>();
  for (const row of (data ?? []) as Array<{ category: string | null }>) {
    if (row.category) set.add(row.category);
  }
  return [...set].sort();
}

/**
 * History the recurring-charge detector reads - Spec section 8.
 *
 * Deliberately wider than the dashboard's window. An annual subscription needs
 * two renewals before it can be told apart from a one-off, and at 400 days it
 * would never gather them: the yearly licences, the ones most worth catching,
 * would be the exact charges that stayed invisible.
 */
const SUBSCRIPTION_WINDOW_DAYS = 1_100; // three years, enough for two annual renewals

export async function loadRecurringCharges(
  db: SupabaseClient,
  asOf: ISODate = today(),
): Promise<{
  charges: RecurringCharge[];
  summary: SubscriptionSummary;
  scannedFrom: ISODate;
  scanned: number;
}> {
  const scannedFrom = addDays(asOf, -SUBSCRIPTION_WINDOW_DAYS);

  const [txnRes, rates] = await Promise.all([
    db
      .from('transactions')
      .select(TXN_SELECT)
      .eq('direction', 'outflow')
      .gte('txn_date', scannedFrom)
      .lte('txn_date', asOf)
      .order('txn_date', { ascending: true })
      .limit(20_000),
    loadUsdRates(db, asOf),
  ]);

  const transactions = (txnRes.data ?? []) as TransactionWithContext[];
  const charges = detectRecurringCharges(transactions as Transaction[], { asOf, rates });

  return {
    charges,
    summary: summariseSubscriptions(charges, asOf),
    scannedFrom,
    scanned: transactions.length,
  };
}
