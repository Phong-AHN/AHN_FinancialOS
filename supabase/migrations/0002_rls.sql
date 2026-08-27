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
