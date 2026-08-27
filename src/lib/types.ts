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
  | 'csv_vn_bank'
  | 'csv_veem'
  | 'csv_payroll'
  | 'manual';
export type IntegrationProvider = 'quickbooks' | 'plaid' | 'stripe';
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
  | 'price_increase';
export type AlertSeverity = 'info' | 'warning' | 'critical' | 'digest';
export type NotificationChannel = 'slack' | 'email' | 'sms' | 'in_app';
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped';
export type UserRole = 'owner' | 'viewer';

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
}
