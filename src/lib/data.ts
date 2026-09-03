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
  BusinessUnit,
  Project,
  ProjectWithContext,
  AuditLog,
  FinancialAccount,
  NotificationRow,
  Transaction,
  TransactionWithContext,
} from '@/lib/types';
import {
  computeBurnRate,
  computeSnapshot,
  countsTowardCash,
  type FinancialSnapshot,
  type UsdRateMap,
} from '@/lib/calc/engine';
import {
  buildScenarios,
  computeBaseline,
  type Baseline,
  type Scenario,
} from '@/lib/calc/simulator';
import { loadUsdRates } from '@/lib/fx';
import { addDays, today, type ISODate } from '@/lib/dates';
import {
  comparePeriods,
  detectAnomalies,
  explainCashChange,
  type Anomaly,
  type CashChange,
  type PeriodComparison,
} from '@/lib/calc/explain';
import {
  agingReport,
  findLikelySettled,
  projectCash,
  summarise,
  type AgingLine,
  type CashProjection,
  type LedgerSummary,
  type LikelySettlement,
  type Obligation,
} from '@/lib/calc/obligations';
import {
  budgetTotals,
  computeBudgetStatus,
  type BudgetRow,
  type BudgetStatus,
  type BudgetTotals,
  type ScopeContext,
} from '@/lib/calc/budgets';
import {
  computeNetProfit,
  computeProjectLabour,
  detectLabourDoubleCount,
  type DoubleCountWarning,
  type NetProfit,
  type Person,
  type ProjectLabour,
  type TimeEntry,
} from '@/lib/calc/labour';
import {
  computeProjectPnl,
  groupByProject,
  portfolioTotals,
  type PortfolioTotals,
  type ProjectPnl,
  type ProjectSummaryRow,
} from '@/lib/calc/projects';
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
  /** Rows attributed to one project or event. */
  projectId?: string;
  /** Rows attributed to nothing — the queue for spec §12 attribution. */
  unassigned?: boolean;
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
    is: (c: string, v: unknown) => typeof q;
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
  if (filters.projectId) q = q.eq('project_id', filters.projectId);
  if (filters.unassigned) q = q.is('project_id', null);
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

// ─── Projects and events (spec sections 12, 14, 15, 16) ─────────────────────

const PROJECT_SELECT =
  '*, business_unit:business_units(id,name), client:clients(id,name)';

export interface ProjectPortfolio {
  rows: Array<ProjectSummaryRow<ProjectWithContext>>;
  totals: PortfolioTotals;
  unassigned: Transaction[];
  units: BusinessUnit[];
  rates: UsdRateMap;
}

/**
 * Every project with its P&L, in three queries rather than one per project.
 *
 * The transaction pull is deliberately unfiltered by project: fetching each
 * project's rows separately would be one Tokyo round trip per project, and a
 * page that gets slower with every project AHN runs is a page nobody opens.
 */
export async function loadProjectPortfolio(
  db: SupabaseClient,
  asOf: ISODate = today(),
): Promise<ProjectPortfolio> {
  const [projectsRes, txnRes, unitsRes, rates] = await Promise.all([
    db.from('projects').select(PROJECT_SELECT).order('created_at', { ascending: false }),
    db
      .from('transactions')
      .select(TXN_SELECT)
      .gte('txn_date', addDays(asOf, -PROJECT_WINDOW_DAYS))
      .lte('txn_date', asOf)
      .limit(20_000),
    db.from('business_units').select('*').order('sort_order'),
    loadUsdRates(db, asOf),
  ]);

  const projects = (projectsRes.data ?? []) as ProjectWithContext[];
  const transactions = (txnRes.data ?? []) as TransactionWithContext[];

  const { rows, unassigned } = groupByProject(projects, transactions as Transaction[], rates);

  return {
    rows,
    totals: portfolioTotals(rows, unassigned),
    unassigned,
    units: (unitsRes.data ?? []) as BusinessUnit[],
    rates,
  };
}

/** Two years: long enough for an annual event to show its previous edition. */
const PROJECT_WINDOW_DAYS = 730;

export interface LoadedProject {
  project: ProjectWithContext;
  pnl: ProjectPnl;
  transactions: TransactionWithContext[];
  /**
   * Labour, or null when the caller cannot see it.
   *
   * `people` and `time_entries` are owner-only (migration 0013) because a rate
   * is compensation. A viewer therefore reads zero hours — and zero labour
   * subtracted from gross profit would render as a NET profit that is really
   * the gross one. Null forces the page to say "not visible to you" instead of
   * showing a number that is wrong by exactly the payroll it is hiding.
   */
  labour: ProjectLabour | null;
  net: NetProfit | null;
  doubleCount: DoubleCountWarning | null;
}

export async function loadProject(
  db: SupabaseClient,
  id: string,
  opts: {
    asOf?: ISODate;
    /**
     * Whether this reader may see what people cost.
     *
     * Defaults to FALSE, which is the safe direction: a caller that forgets to
     * pass it gets "not visible to you" rather than a net profit computed from
     * a labour cost of zero.
     */
    canSeeCompensation?: boolean;
  } = {},
): Promise<LoadedProject | null> {
  const asOf = opts.asOf ?? today();
  const [projectRes, txnRes, timeRes, peopleRes, rates] = await Promise.all([
    db.from('projects').select(PROJECT_SELECT).eq('id', id).maybeSingle(),
    db
      .from('transactions')
      .select(TXN_SELECT)
      .eq('project_id', id)
      .order('txn_date', { ascending: false })
      .limit(5_000),
    db.from('time_entries').select('*').eq('project_id', id).limit(20_000),
    db.from('people').select('*'),
    loadUsdRates(db, asOf),
  ]);

  const project = projectRes.data as ProjectWithContext | null;
  if (!project) return null;

  const transactions = (txnRes.data ?? []) as TransactionWithContext[];
  const pnl = computeProjectPnl(transactions as Transaction[], project, rates);

  /*
   * WHY THIS IS THE CALLER'S CAPABILITY AND NOT A QUERY ERROR.
   *
   * This used to read `!timeRes.error && !peopleRes.error`, on the stated
   * belief that "RLS answers a viewer with an error, not an empty list". It
   * does not. A blocked select comes back HTTP 200 with `[]` and no error at
   * all — verified against a real viewer token.
   *
   * So the guard never fired. A viewer opening a project got labour computed
   * from zero people, a labour cost of 0, and a NET profit identical to the
   * gross one — presented as net. That is the confident zero this codebase
   * refuses everywhere else, and it was hiding the single largest cost a
   * project has.
   *
   * An empty list genuinely cannot distinguish the two cases, because "nobody
   * has logged time" and "you may not see who did" look identical from here.
   * The capability can, and it is the same rule `can_see_compensation()`
   * enforces in Postgres — with `tests/rbac.integration.test.ts` asserting the
   * two agree.
   */
  const canSeeLabour = opts.canSeeCompensation === true;

  if (!canSeeLabour) {
    return { project, pnl, transactions, labour: null, net: null, doubleCount: null };
  }

  const labour = computeProjectLabour(
    (timeRes.data ?? []) as TimeEntry[],
    (peopleRes.data ?? []) as Person[],
    project,
  );

  return {
    project,
    pnl,
    transactions,
    labour,
    net: computeNetProfit(pnl.grossProfitUsdMinor, pnl.cashReceivedUsdMinor, labour.actualCostUsdMinor),
    doubleCount: detectLabourDoubleCount(
      transactions as Transaction[],
      labour.actualCostUsdMinor,
      rates,
    ),
  };
}

export async function loadProjectOptions(
  db: SupabaseClient,
): Promise<Array<Pick<Project, 'id' | 'name' | 'kind' | 'status'>>> {
  const { data } = await db
    .from('projects')
    .select('id,name,kind,status')
    .in('status', ['planned', 'active'])
    .order('name');
  return (data ?? []) as Array<Pick<Project, 'id' | 'name' | 'kind' | 'status'>>;
}

// ─── Growth and margin simulator (spec section 11) ──────────────────────────

/**
 * Twelve months of complete months, not the three the burn rate uses.
 *
 * Burn wants a recent average, so three months is right for it. A growth plan
 * wants a distribution — the weakest month, the median, the strongest — and
 * three points cannot describe one. Twelve also spans a full seasonal cycle,
 * which matters for a business with an events line.
 */
const SIMULATOR_MONTHS = 12;

export async function loadSimulatorBaseline(
  db: SupabaseClient,
  asOf: ISODate = today(),
): Promise<{ baseline: Baseline; scenarios: Scenario[]; asOf: ISODate }> {
  const [txnRes, rates] = await Promise.all([
    db
      .from('transactions')
      .select('*')
      .gte('txn_date', addDays(asOf, -(SIMULATOR_MONTHS + 2) * 31))
      .lte('txn_date', asOf)
      .limit(20_000),
    loadUsdRates(db, asOf),
  ]);

  const burn = computeBurnRate(
    (txnRes.data ?? []) as Transaction[],
    asOf,
    SIMULATOR_MONTHS,
    rates,
  );

  const baseline = computeBaseline(burn.perMonth);
  return { baseline, scenarios: buildScenarios(baseline), asOf };
}

// ─── Budgets (spec section 19) ──────────────────────────────────────────────

export interface BudgetBoard {
  statuses: BudgetStatus[];
  totals: BudgetTotals;
  asOf: ISODate;
  /**
   * Projects carrying a lifetime budget on the project row AS WELL AS a
   * period budget here.
   *
   * Both are legitimate — one is what a piece of work may cost in total, the
   * other what it may cost this month — but a reader seeing two different
   * budget figures for the same project needs to be told why, or they will
   * assume one of them is a bug.
   */
  projectsWithTwoBudgets: Array<{ id: string; name: string }>;
}

export async function loadBudgetBoard(
  db: SupabaseClient,
  asOf: ISODate = today(),
): Promise<BudgetBoard> {
  const [budgetsRes, txnRes, projectsRes, accountsRes, rates] = await Promise.all([
    db.from('budgets').select('*').eq('is_active', true).order('starts_on', { ascending: false }),
    db
      .from('transactions')
      .select('*')
      // A year covers every period type a budget can use, with room for a
      // quarter or year that started before the window would otherwise reach.
      .gte('txn_date', addDays(asOf, -450))
      .lte('txn_date', asOf)
      .limit(20_000),
    db.from('projects').select('id,name,business_unit_id,client_id,budget_expense_minor'),
    db.from('financial_accounts').select('id,company_id'),
    loadUsdRates(db, asOf),
  ]);

  const budgets = (budgetsRes.data ?? []) as BudgetRow[];
  const transactions = (txnRes.data ?? []) as Array<Transaction & { project_id?: string | null }>;
  const projects = (projectsRes.data ?? []) as Array<{
    id: string;
    name: string;
    business_unit_id: string | null;
    client_id: string | null;
    budget_expense_minor: number | null;
  }>;

  const context: ScopeContext = {
    projectMeta: new Map(
      projects.map((p) => [p.id, { businessUnitId: p.business_unit_id, clientId: p.client_id }]),
    ),
    companyOfAccount: new Map(
      ((accountsRes.data ?? []) as Array<{ id: string; company_id: string | null }>).map((a) => [
        a.id,
        a.company_id,
      ]),
    ),
  };

  const statuses = budgets.map((b) =>
    computeBudgetStatus(b, transactions, asOf, context, rates),
  );

  const budgetedProjectIds = new Set(
    budgets.filter((b) => b.scope === 'project' && b.scope_id).map((b) => b.scope_id!),
  );

  return {
    statuses,
    totals: budgetTotals(statuses),
    asOf,
    projectsWithTwoBudgets: projects
      .filter((p) => p.budget_expense_minor !== null && budgetedProjectIds.has(p.id))
      .map((p) => ({ id: p.id, name: p.name })),
  };
}

/** Scope targets a person can pick when creating a budget. */
export async function loadBudgetTargets(db: SupabaseClient): Promise<{
  companies: Array<{ id: string; name: string }>;
  businessUnits: Array<{ id: string; name: string }>;
  clients: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
  categories: string[];
}> {
  const [companies, units, clients, projects, categories] = await Promise.all([
    db.from('companies').select('id,name').order('name'),
    db.from('business_units').select('id,name').eq('is_active', true).order('sort_order'),
    db.from('clients').select('id,name').order('name'),
    db.from('projects').select('id,name').in('status', ['planned', 'active']).order('name'),
    loadCategories(db),
  ]);

  return {
    companies: (companies.data ?? []) as Array<{ id: string; name: string }>,
    businessUnits: (units.data ?? []) as Array<{ id: string; name: string }>,
    clients: (clients.data ?? []) as Array<{ id: string; name: string }>,
    projects: (projects.data ?? []) as Array<{ id: string; name: string }>,
    categories: categories.filter((c) => c !== 'revenue' && c !== 'transfer'),
  };
}

// ─── Receivables and payables (spec sections 17, 18) ────────────────────────

export interface ObligationBoard {
  receivables: Obligation[];
  payables: Obligation[];
  receivableSummary: LedgerSummary;
  payableSummary: LedgerSummary;
  receivableAging: AgingLine[];
  payableAging: AgingLine[];
  projection: CashProjection;
  /**
   * Open obligations a real payment appears to have already settled.
   *
   * Until somebody marks them settled, projected cash subtracts them a second
   * time — telling a company that has already paid its rent that it still has
   * to. Surfaced as suggestions, never applied automatically.
   */
  likelySettled: LikelySettlement[];
  asOf: ISODate;
}

export async function loadObligationBoard(
  db: SupabaseClient,
  asOf: ISODate = today(),
  horizonDays = 30,
): Promise<ObligationBoard> {
  const [obligationsRes, dashboard] = await Promise.all([
    db.from('obligations').select('*').neq('status', 'void').order('due_on'),
    loadDashboard(db, asOf),
  ]);

  const obligations = (obligationsRes.data ?? []) as Obligation[];
  const receivables = obligations.filter((o) => o.direction === 'inflow');
  const payables = obligations.filter((o) => o.direction === 'outflow');

  const { rates, snapshot, transactions } = dashboard;

  return {
    receivables,
    payables,
    receivableSummary: summarise(receivables, asOf, rates),
    payableSummary: summarise(payables, asOf, rates),
    receivableAging: agingReport(receivables, asOf, rates),
    payableAging: agingReport(payables, asOf, rates),
    projection: projectCash(
      snapshot.cash.totalUsdMinor,
      obligations,
      asOf,
      horizonDays,
      rates,
    ),
    likelySettled: findLikelySettled(obligations, transactions as Transaction[], { rates }),
    asOf,
  };
}

// ─── Explaining what changed (spec section 20) ──────────────────────────────

export interface ExplainBoard {
  cashChange: CashChange;
  revenue: PeriodComparison;
  spending: PeriodComparison;
  anomalies: Anomaly[];
  windowDays: number;
  asOf: ISODate;
}

/**
 * The deterministic analysis §20 says an AI layer should interpret.
 *
 * The opening balance is derived by walking today's cash BACKWARDS through the
 * window rather than being read from anywhere: no account carries a dated
 * historical balance, and inventing one would make the decomposition reconcile
 * against a number nobody could check.
 */
export async function loadExplainBoard(
  db: SupabaseClient,
  asOf: ISODate = today(),
  windowDays = 30,
): Promise<ExplainBoard> {
  const from = addDays(asOf, -windowDays);
  const priorFrom = addDays(from, -windowDays);

  const [accountsRes, txnRes, rates] = await Promise.all([
    db.from('financial_accounts').select('*'),
    db
      .from('transactions')
      .select(TXN_SELECT)
      .gte('txn_date', addDays(asOf, -400))
      .lte('txn_date', asOf)
      .limit(20_000),
    loadUsdRates(db, asOf),
  ]);

  const accounts = (accountsRes.data ?? []) as FinancialAccount[];
  const transactions = (txnRes.data ?? []) as TransactionWithContext[];
  const snapshot = computeSnapshot(accounts, transactions as Transaction[], asOf, rates);

  const movedInWindow = (transactions as Transaction[])
    .filter((t) => t.txn_date >= from && t.txn_date <= asOf)
    .reduce((sum, t) => {
      if (t.is_internal_transfer || !countsTowardCash(t)) return sum;
      const usd = t.amount_usd_minor ?? 0;
      return sum + (t.direction === 'inflow' ? usd : -usd);
    }, 0);

  const current = (transactions as Transaction[]).filter((t) => t.txn_date >= from);
  const prior = (transactions as Transaction[]).filter(
    (t) => t.txn_date >= priorFrom && t.txn_date < from,
  );

  return {
    cashChange: explainCashChange(
      snapshot.cash.totalUsdMinor - movedInWindow,
      transactions as Transaction[],
      from,
      asOf,
      rates,
    ),
    revenue: comparePeriods(current, prior, 'inflow', rates),
    spending: comparePeriods(current, prior, 'outflow', rates),
    anomalies: detectAnomalies(transactions as Transaction[], {
      asOf,
      lookbackDays: windowDays,
      rates,
    }),
    windowDays,
    asOf,
  };
}
