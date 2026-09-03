/**
 * Domain types mirroring the Week-1 schema (supabase/migrations/0001_init.sql).
 *
 * Hand-written rather than generated so the money invariants are documented
 * where they are used: `*_minor` fields are integers, `amount_minor` is always
 * positive, and `direction` carries the sign.
 */

export type EntityCountry = 'US' | 'VN' | 'PH' | 'OTHER';
export type AccountType =
  | 'checking'
  | 'savings'
  | 'credit_card'
  | 'payment_processor'
  | 'cash'
  /** Money owed. Never counts toward cash - Plaid reports the balance owed as a POSITIVE number. */
  | 'loan'
  /** Retirement and brokerage holdings. Real, but not cash available to spend. */
  | 'investment'
  | 'other';
export type SourceSystem =
  | 'quickbooks'
  | 'plaid'
  | 'stripe'
  /** Aggregator; individual accounts only, so a fallback for Vietnam. */
  | 'finverse'
  /** VietinBank iConnect ERP Statement API — the corporate route. */
  | 'vietinbank'
  | 'csv_vn_bank'
  | 'csv_veem'
  | 'csv_payroll'
  | 'manual';
export type IntegrationProvider = 'quickbooks' | 'plaid' | 'stripe' | 'finverse' | 'vietinbank';
export type IntegrationStatus = 'disconnected' | 'connected' | 'error';
export type TxnDirection = 'inflow' | 'outflow';
export type ReconStatus =
  | 'unreconciled'
  | 'matched'
  | 'possible_duplicate'
  | 'duplicate_ignored'
  | 'reconciled';
export type CounterpartyType = 'vendor' | 'customer' | 'employee' | 'internal' | 'unknown';
export type AlertType =
  | 'money_in'
  | 'money_out'
  | 'large_outflow'
  | 'low_runway'
  | 'low_balance'
  | 'daily_summary'
  | 'weekly_summary'
  | 'price_increase'
  | 'budget_overspend'
  | 'overdue_receivable'
  | 'upcoming_obligation';
export type AlertSeverity = 'info' | 'warning' | 'critical' | 'digest';
export type NotificationChannel = 'slack' | 'email' | 'sms' | 'in_app';
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped';
/**
 * Spec §23's seven roles. What each may do lives in `@/lib/capabilities`,
 * mirroring the database, which is the authority.
 */
export type UserRole =
  | 'owner'
  | 'cfo'
  | 'accountant'
  | 'department_lead'
  | 'project_manager'
  | 'employee'
  | 'viewer';

export interface Company {
  id: string;
  name: string;
  entity_country: EntityCountry;
  currency: string;
  is_active: boolean;
  created_at: string;
}

export interface FinancialAccount {
  id: string;
  company_id: string;
  name: string;
  type: AccountType;
  currency: string;
  source_system: SourceSystem;
  external_account_id: string | null;
  mask: string | null;
  opening_balance_minor: number;
  reported_balance_minor: number | null;
  reported_balance_at: string | null;
  include_in_cash: boolean;
  is_active: boolean;
  created_at: string;
}

export interface Integration {
  id: string;
  provider: IntegrationProvider;
  label: string | null;
  status: IntegrationStatus;
  external_id: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  last_synced_at: string | null;
  last_cursor: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Counterparty {
  id: string;
  name: string;
  normalized_name: string;
  type: CounterpartyType;
  source_system: SourceSystem;
  external_id: string | null;
  created_at: string;
}

export interface Transaction {
  id: string;
  account_id: string;
  counterparty_id: string | null;
  txn_date: string;
  posted_at: string | null;
  /** Always >= 0. Sign lives in `direction`. */
  amount_minor: number;
  currency: string;
  direction: TxnDirection;
  amount_usd_minor: number | null;
  fx_rate: number | null;
  description: string | null;
  category: string | null;
  subcategory: string | null;
  is_internal_transfer: boolean;
  /** Which project or event this line belongs to; null for overheads. */
  project_id: string | null;
  is_recurring: boolean;
  is_subscription: boolean;
  source_system: SourceSystem;
  external_txn_id: string;
  reconciliation_status: ReconStatus;
  duplicate_of_id: string | null;
  manual_import_id: string | null;
  notes: string | null;
  raw: Record<string, unknown> | null;
  alerted_at: string | null;
  created_at: string;
  updated_at: string;
  /** Generated in Postgres: +amount for inflow, -amount for outflow. */
  signed_minor: number;
  signed_usd_minor: number;
}

/** A transaction joined with the labels the UI needs. */
export interface TransactionWithContext extends Transaction {
  account?: Pick<FinancialAccount, 'id' | 'name' | 'currency' | 'type'> | null;
  counterparty?: Pick<Counterparty, 'id' | 'name' | 'type'> | null;
}

export interface AlertRule {
  id: string;
  name: string;
  type: AlertType;
  severity: AlertSeverity;
  channels: NotificationChannel[];
  threshold_minor: number | null;
  threshold_number: number | null;
  enabled: boolean;
  config: Record<string, unknown>;
  created_at: string;
}

export interface NotificationRow {
  id: string;
  alert_rule_id: string | null;
  transaction_id: string | null;
  channel: NotificationChannel;
  severity: AlertSeverity;
  title: string;
  body: string;
  status: NotificationStatus;
  error: string | null;
  sent_at: string | null;
  /**
   * Snapshot of what the alert was about, added by migration 0004.
   *
   * It keeps the delivery log readable after the transaction it referred to is
   * gone, and it is what price-increase alerts use to remember which rises they
   * have already announced.
   */
  context: Record<string, unknown> | null;
  created_at: string;
}

export interface AppUser {
  id: string;
  auth_id: string | null;
  email: string;
  full_name: string | null;
  role: UserRole;
  created_at: string;
}

export interface AuditLog {
  id: string;
  table_name: string;
  record_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  user_id: string | null;
  user_email: string | null;
  reason: string | null;
  changed_at: string;
}

export interface ManualImport {
  id: string;
  source_label: SourceSystem;
  account_id: string | null;
  file_name: string;
  row_count: number;
  inserted_count: number;
  skipped_count: number;
  imported_by: string | null;
  imported_at: string;
  column_map: Record<string, unknown>;
}

export interface ExchangeRate {
  id: string;
  base_currency: string;
  quote_currency: string;
  rate: number;
  as_of: string;
  source: string;
  created_at: string;
}

/**
 * A transaction ready to be written by a connector. `external_txn_id` is the
 * dedup key: the same activity pulled twice from one source collapses onto the
 * same row via the (source_system, external_txn_id) unique index.
 */
export interface NormalizedTransaction {
  account_id: string;
  txn_date: string;
  posted_at?: string | null;
  amount_minor: number;
  currency: string;
  direction: TxnDirection;
  description?: string | null;
  category?: string | null;
  subcategory?: string | null;
  counterparty_name?: string | null;
  counterparty_type?: CounterpartyType;
  is_internal_transfer?: boolean;
  is_recurring?: boolean;
  is_subscription?: boolean;
  source_system: SourceSystem;
  external_txn_id: string;
  manual_import_id?: string | null;
  notes?: string | null;
  raw?: Record<string, unknown> | null;
}

export interface SyncResult {
  provider: string;
  inserted: number;
  updated: number;
  skipped: number;
  accounts_touched: number;
  error?: string;
  /**
   * Receivables and payables pulled alongside the cash (spec sections 17-18).
   *
   * Reported separately from `inserted` on purpose: these are accruals, and
   * folding them into a count of transactions is the exact confusion the
   * connector avoids by not ingesting invoices as cash in the first place.
   */
  obligations?: {
    inserted: number;
    updated: number;
    settled: number;
    skipped: number;
  };
}

// ─── Projects and events (spec sections 12, 14, 15, 16) ─────────────────────

export type ProjectKind = 'project' | 'event';
export type ProjectStatus = 'planned' | 'active' | 'completed' | 'cancelled';

export interface BusinessUnit {
  id: string;
  name: string;
  /** Free text, because spec 15 requires these to stay admin-editable. */
  services: string[];
  is_active: boolean;
  sort_order: number;
  created_at: string;
}

export interface Client {
  id: string;
  name: string;
  normalized_name: string;
  counterparty_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  company_id: string | null;
  business_unit_id: string | null;
  client_id: string | null;
  name: string;
  code: string | null;
  kind: ProjectKind;
  service: string | null;
  status: ProjectStatus;
  starts_on: string | null;
  ends_on: string | null;
  /**
   * Human-supplied. Null means nobody has said, which is not the same as zero -
   * see the note in `@/lib/calc/projects`.
   */
  contracted_revenue_minor: number | null;
  invoiced_revenue_minor: number | null;
  budget_expense_minor: number | null;
  /** Spec §13 targets, also human-supplied and also null until entered. */
  estimated_hours: number | null;
  labour_budget_minor: number | null;
  currency: string;
  owner_user_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectWithContext extends Project {
  business_unit?: Pick<BusinessUnit, 'id' | 'name'> | null;
  client?: Pick<Client, 'id' | 'name'> | null;
}

// ─── Time tracking (spec section 13) ────────────────────────────────────────

export type PersonKind = 'employee' | 'contractor';
/** The three costing bases spec §13 names. */
export type CostBasis = 'salaried' | 'hourly' | 'contractor_rate';

export interface PersonRow {
  id: string;
  name: string;
  email: string | null;
  kind: PersonKind;
  basis: CostBasis;
  /** Loaded: salary plus employer taxes and benefits, not the headline salary. */
  annual_cost_minor: number | null;
  hourly_cost_minor: number | null;
  /** Hours available in a year. 1,880 is full-time after leave; 2,080 without. */
  annual_hours: number;
  currency: string;
  is_active: boolean;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TimeEntryRow {
  id: string;
  person_id: string;
  project_id: string;
  work_date: string;
  hours: number;
  notes: string | null;
  created_at: string;
}

export interface TimeEntryWithContext extends TimeEntryRow {
  person?: Pick<PersonRow, 'id' | 'name' | 'kind'> | null;
  project?: Pick<Project, 'id' | 'name' | 'kind'> | null;
}

// ─── Budgets (spec section 19) ──────────────────────────────────────────────

export type BudgetScopeName =
  | 'company'
  | 'business_unit'
  | 'client'
  | 'project'
  | 'category'
  | 'total';

export type BudgetPeriodName = 'month' | 'quarter' | 'year';

export interface Budget {
  id: string;
  name: string;
  scope: BudgetScopeName;
  /** The company, unit, client or project. Null for `category` and `total`. */
  scope_id: string | null;
  /** The category name. Categories are text on transactions, not rows. */
  scope_key: string | null;
  period: BudgetPeriodName;
  starts_on: string;
  amount_minor: number;
  currency: string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ─── Receivables and payables (spec sections 17, 18) ────────────────────────

export type ObligationStatusName = 'draft' | 'open' | 'settled' | 'void';

export interface ObligationRow {
  id: string;
  /** `inflow` = owed to AHN (§17); `outflow` = owed by AHN (§18). */
  direction: TxnDirection;
  counterparty_id: string | null;
  counterparty_name: string | null;
  project_id: string | null;
  category: string | null;
  reference: string | null;
  description: string | null;
  amount_minor: number;
  currency: string;
  /** What was agreed, when only part of it has been invoiced. */
  contracted_amount_minor: number | null;
  issued_on: string | null;
  due_on: string;
  status: ObligationStatusName;
  settled_txn_id: string | null;
  settled_on: string | null;
  is_recurring: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
