-- ===========================================================================
-- AHN Financial OS - complete schema, generated file. Do not edit by hand.
--
-- Regenerate with:  node scripts/bundle-sql.mjs
-- Source:           supabase/migrations/*.sql
--
-- Paste the whole file into the Supabase SQL editor and run it. Every
-- statement is idempotent, so running it twice is safe.
-- ===========================================================================


-- ==========================================================================
-- 0001_init.sql
-- ==========================================================================

-- ============================================================================
-- AHN Financial OS - Week-1 schema (MVP Plan section 4, Spec section 27)
--
-- Money rule: every amount is stored as a BIGINT in the currency MINOR unit
-- (USD cents, VND dong). No floats anywhere in the money path - spec 9 and 28
-- require deterministic math that reconciles to the bank to the cent.
--
-- Sign rule: amount_minor is ALWAYS positive. `direction` carries the sign.
-- Use the signed_minor generated column when summing a mixed set.
-- ============================================================================

create extension if not exists pgcrypto;

-- --- Enums ------------------------------------------------------------------
do $enums$ begin
  create type entity_country       as enum ('US','VN','PH','OTHER');
  create type account_type         as enum ('checking','savings','credit_card','payment_processor','cash','other');
  create type source_system        as enum ('quickbooks','plaid','stripe','csv_vn_bank','csv_veem','csv_payroll','manual');
  create type integration_provider as enum ('quickbooks','plaid','stripe');
  create type integration_status   as enum ('disconnected','connected','error');
  create type txn_direction        as enum ('inflow','outflow');
  create type recon_status         as enum ('unreconciled','matched','possible_duplicate','duplicate_ignored','reconciled');
  create type counterparty_type    as enum ('vendor','customer','employee','internal','unknown');
  create type alert_type           as enum ('money_in','money_out','large_outflow','low_runway','low_balance','daily_summary','weekly_summary');
  create type alert_severity       as enum ('info','warning','critical','digest');
  create type notification_channel as enum ('slack','email','sms','in_app');
  create type notification_status  as enum ('pending','sent','failed','skipped');
  create type user_role            as enum ('owner','viewer');
exception when duplicate_object then null; end $enums$;

-- --- 1. companies -----------------------------------------------------------
create table if not exists companies (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  entity_country entity_country not null default 'US',
  currency       char(3) not null default 'USD',
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);

-- --- 2. financial_accounts --------------------------------------------------
-- reported_balance_minor is what the provider says. The derived balance is
-- opening_balance + sum(signed transactions). Spec 28 requires the two to
-- reconcile; the reconcile page surfaces the delta rather than hiding it.
create table if not exists financial_accounts (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references companies(id) on delete cascade,
  name                   text not null,
  type                   account_type not null default 'checking',
  currency               char(3) not null default 'USD',
  source_system          source_system not null default 'manual',
  external_account_id    text,
  mask                   text,
  opening_balance_minor  bigint not null default 0,
  reported_balance_minor bigint,
  reported_balance_at    timestamptz,
  include_in_cash        boolean not null default true,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  unique (source_system, external_account_id)
);
create index if not exists idx_accounts_company on financial_accounts(company_id);

-- --- 3. integrations --------------------------------------------------------
-- Tokens are AES-256-GCM encrypted by the app before they reach the DB
-- (spec 25: secrets outside application code, encrypted at rest).
create table if not exists integrations (
  id                uuid primary key default gen_random_uuid(),
  provider          integration_provider not null,
  label             text,
  status            integration_status not null default 'disconnected',
  external_id       text,
  access_token_enc  text,
  refresh_token_enc text,
  token_expires_at  timestamptz,
  last_synced_at    timestamptz,
  last_cursor       text,
  last_error        text,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  unique (provider, external_id)
);

-- --- 4. counterparties ------------------------------------------------------
create table if not exists counterparties (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  normalized_name text not null,
  type            counterparty_type not null default 'unknown',
  source_system   source_system not null default 'manual',
  external_id     text,
  created_at      timestamptz not null default now(),
  unique (normalized_name, type)
);

-- --- 5. transactions --------------------------------------------------------
create table if not exists transactions (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references financial_accounts(id) on delete cascade,
  counterparty_id       uuid references counterparties(id) on delete set null,
  txn_date              date not null,
  posted_at             timestamptz,
  amount_minor          bigint not null check (amount_minor >= 0),
  currency              char(3) not null default 'USD',
  direction             txn_direction not null,
  amount_usd_minor      bigint,
  fx_rate               numeric(20,10),
  description           text,
  category              text,
  subcategory           text,
  -- An internal transfer moves money between our own accounts. It is neither
  -- revenue nor expense, so burn and break-even must skip it.
  is_internal_transfer  boolean not null default false,
  is_recurring          boolean not null default false,
  is_subscription       boolean not null default false,
  source_system         source_system not null,
  external_txn_id       text not null,
  reconciliation_status recon_status not null default 'unreconciled',
  duplicate_of_id       uuid references transactions(id) on delete set null,
  manual_import_id      uuid,
  notes                 text,
  raw                   jsonb,
  alerted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Same activity arriving twice from the SAME source can never double-count.
  unique (source_system, external_txn_id),
  signed_minor bigint generated always as (
    case when direction = 'inflow' then amount_minor else -amount_minor end
  ) stored,
  signed_usd_minor bigint generated always as (
    case when direction = 'inflow' then coalesce(amount_usd_minor, 0)
         else -coalesce(amount_usd_minor, 0) end
  ) stored
);
create index if not exists idx_txn_date        on transactions(txn_date desc);
create index if not exists idx_txn_account     on transactions(account_id, txn_date desc);
create index if not exists idx_txn_recon       on transactions(reconciliation_status);
create index if not exists idx_txn_unalerted   on transactions(alerted_at) where alerted_at is null;
create index if not exists idx_txn_dedup_probe on transactions(txn_date, amount_minor, direction);
create index if not exists idx_txn_category    on transactions(category);

-- --- 6. alert_rules ---------------------------------------------------------
create table if not exists alert_rules (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  type             alert_type not null,
  severity         alert_severity not null default 'info',
  channels         notification_channel[] not null default '{slack,email}',
  threshold_minor  bigint,
  threshold_number numeric,
  enabled          boolean not null default true,
  config           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

-- --- 7. notifications -------------------------------------------------------
create table if not exists notifications (
  id             uuid primary key default gen_random_uuid(),
  alert_rule_id  uuid references alert_rules(id) on delete set null,
  transaction_id uuid references transactions(id) on delete cascade,
  channel        notification_channel not null,
  severity       alert_severity not null default 'info',
  title          text not null,
  body           text not null,
  status         notification_status not null default 'pending',
  error          text,
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists idx_notif_created on notifications(created_at desc);

-- --- 8. users ---------------------------------------------------------------
create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  auth_id    uuid unique,
  email      text not null unique,
  full_name  text,
  role       user_role not null default 'viewer',
  created_at timestamptz not null default now()
);

-- --- 9. audit_logs ----------------------------------------------------------
create table if not exists audit_logs (
  id         uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id  uuid not null,
  field      text not null,
  old_value  text,
  new_value  text,
  user_id    uuid references users(id) on delete set null,
  user_email text,
  reason     text,
  changed_at timestamptz not null default now()
);
create index if not exists idx_audit_record on audit_logs(table_name, record_id, changed_at desc);
create index if not exists idx_audit_time   on audit_logs(changed_at desc);

-- --- 10. manual_imports -----------------------------------------------------
create table if not exists manual_imports (
  id             uuid primary key default gen_random_uuid(),
  source_label   source_system not null,
  account_id     uuid references financial_accounts(id) on delete set null,
  file_name      text not null,
  row_count      integer not null default 0,
  inserted_count integer not null default 0,
  skipped_count  integer not null default 0,
  imported_by    uuid references users(id) on delete set null,
  imported_at    timestamptz not null default now(),
  column_map     jsonb not null default '{}'::jsonb
);

do $fk$ begin
  alter table transactions
    add constraint fk_txn_manual_import
    foreign key (manual_import_id) references manual_imports(id) on delete set null;
exception when duplicate_object then null; end $fk$;

-- --- 11. exchange_rates -----------------------------------------------------
-- Deliberate addition to the plan 10 tables: AHN holds USD and VND accounts,
-- and "one correct total cash number" (Definition of Done) cannot be produced
-- without a dated rate. Spec 27 lists it as a core entity.
create table if not exists exchange_rates (
  id             uuid primary key default gen_random_uuid(),
  base_currency  char(3) not null,
  quote_currency char(3) not null,
  rate           numeric(20,10) not null check (rate > 0),
  as_of          date not null,
  source         text not null default 'manual',
  created_at     timestamptz not null default now(),
  unique (base_currency, quote_currency, as_of)
);
create index if not exists idx_fx_lookup on exchange_rates(base_currency, quote_currency, as_of desc);

-- --- updated_at trigger -----------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $trg$
begin
  new.updated_at = now();
  return new;
end $trg$;

drop trigger if exists trg_txn_touch on transactions;
create trigger trg_txn_touch before update on transactions
  for each row execute function touch_updated_at();


-- ==========================================================================
-- 0002_rls.sql
-- ==========================================================================

-- ============================================================================
-- Row Level Security - Day 7 (Spec section 23 roles, section 25 least privilege)
--
-- Week 1 ships two roles: owner (full access) and viewer (read-only, with
-- payroll detail hidden). The full 7-role matrix is Phase 3.
--
-- The sync/cron/alert paths run with the service-role key, which bypasses RLS
-- by design - those are trusted server processes, not user sessions.
-- ============================================================================

-- --- Helpers ----------------------------------------------------------------
create or replace function app_user_role() returns user_role
language sql stable security definer set search_path = public as $fn$
  select role from users where auth_id = auth.uid() limit 1;
$fn$;

create or replace function is_owner() returns boolean
language sql stable as $fn$
  select coalesce(app_user_role() = 'owner', false);
$fn$;

create or replace function is_app_user() returns boolean
language sql stable as $fn$
  select app_user_role() is not null;
$fn$;

-- Payroll and compensation detail is restricted (spec 23: "sensitive
-- information such as payroll and company-wide bank balances must support
-- restricted permissions").
create or replace function is_sensitive_category(cat text) returns boolean
language sql immutable as $fn$
  select coalesce(lower(cat) similar to
    '%(payroll|salary|wage|bonus|commission|compensation|contractor_pay)%', false);
$fn$;

-- --- Enable RLS -------------------------------------------------------------
alter table companies         enable row level security;
alter table financial_accounts enable row level security;
alter table integrations      enable row level security;
alter table counterparties    enable row level security;
alter table transactions      enable row level security;
alter table alert_rules       enable row level security;
alter table notifications     enable row level security;
alter table users             enable row level security;
alter table audit_logs        enable row level security;
alter table manual_imports    enable row level security;
alter table exchange_rates    enable row level security;

-- --- Read policies ----------------------------------------------------------
drop policy if exists p_companies_read on companies;
create policy p_companies_read on companies for select using (is_app_user());

drop policy if exists p_accounts_read on financial_accounts;
create policy p_accounts_read on financial_accounts for select using (is_app_user());

drop policy if exists p_counterparties_read on counterparties;
create policy p_counterparties_read on counterparties for select using (is_app_user());

drop policy if exists p_fx_read on exchange_rates;
create policy p_fx_read on exchange_rates for select using (is_app_user());

drop policy if exists p_alert_rules_read on alert_rules;
create policy p_alert_rules_read on alert_rules for select using (is_app_user());

drop policy if exists p_notifications_read on notifications;
create policy p_notifications_read on notifications for select using (is_app_user());

drop policy if exists p_imports_read on manual_imports;
create policy p_imports_read on manual_imports for select using (is_app_user());

-- Viewers see everything except payroll/compensation lines.
drop policy if exists p_txn_read on transactions;
create policy p_txn_read on transactions for select using (
  is_owner() or (is_app_user() and not is_sensitive_category(category))
);

-- Integration rows carry encrypted tokens; owner only, and never the token
-- columns in a client query (the app selects an explicit column list).
drop policy if exists p_integrations_read on integrations;
create policy p_integrations_read on integrations for select using (is_owner());

drop policy if exists p_audit_read on audit_logs;
create policy p_audit_read on audit_logs for select using (is_owner());

drop policy if exists p_users_read on users;
create policy p_users_read on users for select using (
  is_owner() or auth_id = auth.uid()
);

-- --- Write policies (owner only) --------------------------------------------
drop policy if exists p_txn_write on transactions;
create policy p_txn_write on transactions for update using (is_owner()) with check (is_owner());

drop policy if exists p_txn_insert on transactions;
create policy p_txn_insert on transactions for insert with check (is_owner());

drop policy if exists p_accounts_write on financial_accounts;
create policy p_accounts_write on financial_accounts for all using (is_owner()) with check (is_owner());

drop policy if exists p_alert_rules_write on alert_rules;
create policy p_alert_rules_write on alert_rules for all using (is_owner()) with check (is_owner());

drop policy if exists p_companies_write on companies;
create policy p_companies_write on companies for all using (is_owner()) with check (is_owner());

drop policy if exists p_fx_write on exchange_rates;
create policy p_fx_write on exchange_rates for all using (is_owner()) with check (is_owner());

drop policy if exists p_counterparties_write on counterparties;
create policy p_counterparties_write on counterparties for all using (is_owner()) with check (is_owner());

-- audit_logs is append-only for everyone. Nobody gets update or delete, so a
-- financial edit trail cannot be rewritten after the fact (spec 24).
drop policy if exists p_audit_insert on audit_logs;
create policy p_audit_insert on audit_logs for insert with check (is_app_user());


-- ==========================================================================
-- 0003_defaults.sql
-- ==========================================================================

-- ============================================================================
-- Default alert rules - MVP Plan section 7 (Week-1 alert spec)
-- Idempotent: safe to re-run.
-- ============================================================================

insert into alert_rules (name, type, severity, channels, threshold_minor, threshold_number, config)
select * from (values
  ('Money in - any amount',
   'money_in'::alert_type, 'info'::alert_severity,
   array['slack','email']::notification_channel[], null::bigint, null::numeric,
   '{"description":"Every inflow, no minimum. Spec 4 default alert mode."}'::jsonb),

  ('Money out - any amount',
   'money_out'::alert_type, 'info'::alert_severity,
   array['slack','email']::notification_channel[], null::bigint, null::numeric,
   '{"description":"Every outflow, no minimum. Spec 4 default alert mode."}'::jsonb),

  ('Unusually large outflow',
   'large_outflow'::alert_type, 'warning'::alert_severity,
   array['slack','email','sms']::notification_channel[], 500000::bigint, null::numeric,
   '{"description":"Single outflow above USD 5,000."}'::jsonb),

  ('Low runway',
   'low_runway'::alert_type, 'critical'::alert_severity,
   array['slack','email','sms']::notification_channel[], null::bigint, 6::numeric,
   '{"description":"Runway below 6 months."}'::jsonb),

  ('Low account balance',
   'low_balance'::alert_type, 'critical'::alert_severity,
   array['slack','email','sms']::notification_channel[], 1000000::bigint, null::numeric,
   '{"description":"Any cash account below USD 10,000."}'::jsonb),

  ('Daily CFO summary',
   'daily_summary'::alert_type, 'digest'::alert_severity,
   array['slack','email']::notification_channel[], null::bigint, null::numeric,
   '{"description":"09:00 daily digest.","schedule":"0 9 * * *"}'::jsonb),

  ('Weekly CFO summary',
   'weekly_summary'::alert_type, 'digest'::alert_severity,
   array['slack','email']::notification_channel[], null::bigint, null::numeric,
   '{"description":"Monday morning digest.","schedule":"0 9 * * 1"}'::jsonb)
) as v(name, type, severity, channels, threshold_minor, threshold_number, config)
where not exists (select 1 from alert_rules ar where ar.name = v.name);

-- A starting USD/VND rate so multi-currency rollups have something dated to
-- use on day one. Replace with a real feed in Phase 2.
insert into exchange_rates (base_currency, quote_currency, rate, as_of, source)
values ('VND', 'USD', 0.0000380, current_date, 'seed')
on conflict (base_currency, quote_currency, as_of) do nothing;

insert into exchange_rates (base_currency, quote_currency, rate, as_of, source)
values ('USD', 'USD', 1, current_date, 'seed')
on conflict (base_currency, quote_currency, as_of) do nothing;


-- ==========================================================================
-- 0004_notification_retention.sql
-- ==========================================================================

-- ============================================================================
-- Notifications outlive the transaction they announced.
--
-- `notifications.transaction_id` was ON DELETE CASCADE, which means deleting a
-- transaction silently erased the record that we alerted someone about it.
--
-- That is wrong for two reasons:
--
--   1. Plaid removes a transaction when the bank reverses it, and the sync
--      deletes the row to keep cash honest. Under CASCADE, the fact that the CEO
--      was paged about that money vanished with it - so the alert log disagreed
--      with what people actually received.
--
--   2. The Day-4 end-to-end test creates a transaction, lets it fire a real
--      alert, and removes it again. The proof of delivery has to survive.
--
-- SET NULL keeps the notification, with its title and body intact, and simply
-- drops the link. Spec section 24 is about not being able to erase the record of
-- what happened; this closes the same gap for alert delivery.
-- ============================================================================

alter table notifications
  drop constraint if exists notifications_transaction_id_fkey;

alter table notifications
  add constraint notifications_transaction_id_fkey
  foreign key (transaction_id) references transactions(id) on delete set null;

-- The transaction may be gone, but which account and counterparty it concerned
-- should still be readable from the log.
alter table notifications
  add column if not exists context jsonb not null default '{}'::jsonb;

comment on column notifications.context is
  'Snapshot of the transaction at alert time (account, counterparty, amount), so the log stays readable after the row is deleted.';


-- ==========================================================================
-- 0005_account_types.sql
-- ==========================================================================

-- ============================================================================
-- Loans and investments are not cash.
--
-- Plaid returns six account types: depository, credit, loan, investment,
-- brokerage, other. Everything outside depository/credit was being mapped to
-- `other`, and `other` counted toward cash - so a mortgage, a student loan, an
-- auto loan, a HELOC, a 401k and an IRA all landed in the figure that answers
-- "how much cash do we have?".
--
-- Loans make it worse than a rounding error: Plaid reports the balance OWED as
-- a POSITIVE number, so debt inflated cash. A sandbox connection alone added
-- $182,228 of borrowings and locked-up investments to the headline.
--
-- These two enum values let the account carry what it actually is, so the
-- Accounts page can say "Mortgage" instead of "Other" and the cash rule follows
-- from the type rather than from a flag someone has to remember to set.
-- ============================================================================

do $types$ begin
  alter type account_type add value if not exists 'loan';
exception when duplicate_object then null; end $types$;

do $types$ begin
  alter type account_type add value if not exists 'investment';
exception when duplicate_object then null; end $types$;

-- The reclassification of already-imported rows lives in 0006. Postgres refuses
-- to USE an enum value in the same transaction that ADDED it ("unsafe use of
-- new value"), and the migration runner sends each file as one statement.


-- ==========================================================================
-- 0006_reclassify_plaid_accounts.sql
-- ==========================================================================

-- ============================================================================
-- Reclassify Plaid accounts imported under the old mapping.
--
-- Separate from 0005 because Postgres will not let a transaction use an enum
-- value that the same transaction added.
--
-- Matching on the provider's own subtype would be better, but these rows were
-- written before it was retained, so the name is what there is. New syncs
-- classify from `mapAccountType` and never reach this.
-- ============================================================================

-- Correct anything already imported under the old mapping. Matching on the
-- provider's own subtype in `raw` would be better, but these rows predate it
-- being stored, so the name is what there is.
update financial_accounts
   set type = 'loan', include_in_cash = false
 where source_system = 'plaid'
   and include_in_cash
   and (name ilike '%loan%' or name ilike '%mortgage%' or name ilike '%line of credit%');

update financial_accounts
   set type = 'investment', include_in_cash = false
 where source_system = 'plaid'
   and include_in_cash
   and (name ilike '%401k%' or name ilike '%ira%' or name ilike '%brokerage%');

