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
