-- ============================================================================
-- Capabilities, and the policies that ask about them - Spec sections 23, 25
--
-- Split from 0022 because Postgres will not let a transaction use an enum
-- value added in that same transaction.
--
-- THE WHOLE ROLE MATRIX IS IN THIS FILE, ONCE.
--
--                     owner  cfo  acct  dept  proj  empl  viewer
--   see compensation    Y     Y    Y     -     -     -      -
--   see all money       Y     Y    Y     -     -     -      Y
--   move money          Y     Y    -     -     -     -      -
--   categorise          Y     Y    Y     -     -     -      -
--   manage integrations Y     Y    -     -     -     -      -
--   manage people       Y     Y    -     -     -     -      -
--   manage projects     Y     Y    -     Y     -     -      -
--   read audit          Y     Y    Y     -     -     -      -
--
-- Department leads and project managers are SCOPED rather than lesser viewers:
-- they see their own unit or their own projects and the money attributed to
-- them, and nothing else. An employee sees only their own record and hours.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- --- Capabilities -----------------------------------------------------------

create or replace function can_see_compensation() returns boolean
language sql stable as $fn$
  select app_user_role() in ('owner', 'cfo', 'accountant');
$fn$;

/**
 * Reads every account balance and every transaction.
 *
 * A read-only viewer keeps this, minus compensation, because that is what the
 * role is for. A department lead does NOT: they are scoped to their own unit,
 * which is less than a viewer sees and deliberately so.
 */
create or replace function can_see_all_money() returns boolean
language sql stable as $fn$
  select app_user_role() in ('owner', 'cfo', 'accountant', 'viewer');
$fn$;

/** Writes anything that changes a financial figure. */
create or replace function can_move_money() returns boolean
language sql stable as $fn$
  select app_user_role() in ('owner', 'cfo');
$fn$;

/**
 * Corrects how a transaction is classified.
 *
 * An accountant gets this and not `can_move_money`: reclassifying a payment is
 * their job, connecting a bank account is not.
 */
create or replace function can_categorise() returns boolean
language sql stable as $fn$
  select app_user_role() in ('owner', 'cfo', 'accountant');
$fn$;

/** Holds the keys to the bank connections. The narrowest capability here. */
create or replace function can_manage_integrations() returns boolean
language sql stable as $fn$
  select app_user_role() in ('owner', 'cfo');
$fn$;

/** Sets what a person costs, which is compensation by another name. */
create or replace function can_manage_people() returns boolean
language sql stable as $fn$
  select app_user_role() in ('owner', 'cfo');
$fn$;

create or replace function can_manage_projects() returns boolean
language sql stable as $fn$
  select app_user_role() in ('owner', 'cfo', 'department_lead');
$fn$;

create or replace function can_read_audit() returns boolean
language sql stable as $fn$
  select app_user_role() in ('owner', 'cfo', 'accountant');
$fn$;

-- --- Scoping ----------------------------------------------------------------

/** Our `users.id` for whoever is asking. */
create or replace function current_app_user_id() returns uuid
language sql stable security definer set search_path = public as $fn$
  select id from users where auth_id = auth.uid() limit 1;
$fn$;

/**
 * Projects this reader is scoped to.
 *
 * A project manager gets the projects they own; a department lead gets every
 * project in the unit they lead. Anyone who can see all money gets all of them,
 * so the scoped path never has to be consulted for those roles.
 */
create or replace function scoped_project_ids() returns setof uuid
language sql stable security definer set search_path = public as $fn$
  select p.id
  from projects p
  left join business_units bu on bu.id = p.business_unit_id
  where p.owner_user_id = current_app_user_id()
     or bu.lead_user_id = current_app_user_id();
$fn$;

create or replace function can_see_project(project uuid) returns boolean
language sql stable as $fn$
  select can_see_all_money()
      or (project is not null and project in (select scoped_project_ids()));
$fn$;

-- --- Transactions -----------------------------------------------------------

-- The most consequential policy in the system. A scoped reader sees only the
-- money attributed to their own work; everyone else sees the ledger, minus
-- compensation unless they may see it.
drop policy if exists p_txn_read on transactions;
create policy p_txn_read on transactions for select using (
  is_app_user()
  and (can_see_compensation() or not is_sensitive_transaction(category, subcategory))
  and (
    can_see_all_money()
    or (project_id is not null and project_id in (select scoped_project_ids()))
  )
);

drop policy if exists p_txn_write on transactions;
create policy p_txn_write on transactions for update using (can_categorise()) with check (can_categorise());

-- --- Accounts and balances --------------------------------------------------

-- Section 23 names company-wide bank balances as restricted alongside payroll.
-- A scoped reader has no business seeing what the company holds.
drop policy if exists p_accounts_read on financial_accounts;
create policy p_accounts_read on financial_accounts for select using (can_see_all_money());

drop policy if exists p_accounts_write on financial_accounts;
create policy p_accounts_write on financial_accounts for all using (can_move_money()) with check (can_move_money());

-- --- Reference data everyone signed in may read -----------------------------

drop policy if exists p_companies_read on companies;
create policy p_companies_read on companies for select using (is_app_user());
drop policy if exists p_companies_write on companies;
create policy p_companies_write on companies for all using (can_move_money()) with check (can_move_money());

drop policy if exists p_counterparties_read on counterparties;
create policy p_counterparties_read on counterparties for select using (is_app_user());
drop policy if exists p_counterparties_write on counterparties;
create policy p_counterparties_write on counterparties for all using (can_categorise()) with check (can_categorise());

drop policy if exists p_fx_read on exchange_rates;
create policy p_fx_read on exchange_rates for select using (is_app_user());
drop policy if exists p_fx_write on exchange_rates;
create policy p_fx_write on exchange_rates for all using (can_move_money()) with check (can_move_money());

drop policy if exists p_units_read on business_units;
create policy p_units_read on business_units for select using (is_app_user());
drop policy if exists p_units_write on business_units;
create policy p_units_write on business_units for all using (can_manage_projects()) with check (can_manage_projects());

drop policy if exists p_clients_read on clients;
create policy p_clients_read on clients for select using (is_app_user());
drop policy if exists p_clients_write on clients;
create policy p_clients_write on clients for all using (can_manage_projects()) with check (can_manage_projects());

-- --- Projects ---------------------------------------------------------------

drop policy if exists p_projects_read on projects;
create policy p_projects_read on projects for select using (
  is_app_user() and (can_see_all_money() or id in (select scoped_project_ids()))
);
drop policy if exists p_projects_write on projects;
create policy p_projects_write on projects for all using (can_manage_projects()) with check (can_manage_projects());

-- --- Budgets and obligations ------------------------------------------------

drop policy if exists p_budgets_read on budgets;
create policy p_budgets_read on budgets for select using (
  is_app_user() and (can_see_all_money() or (scope = 'project' and can_see_project(scope_id)))
);
drop policy if exists p_budgets_write on budgets;
create policy p_budgets_write on budgets for all using (can_move_money()) with check (can_move_money());

drop policy if exists p_obligations_read on obligations;
create policy p_obligations_read on obligations for select using (
  is_app_user()
  and (can_see_compensation() or not is_sensitive_category(category))
  and (can_see_all_money() or can_see_project(project_id))
);
drop policy if exists p_obligations_write on obligations;
create policy p_obligations_write on obligations for all using (can_move_money()) with check (can_move_money());

-- --- Compensation -----------------------------------------------------------

-- An employee may see their own record and nobody else's. A rate is
-- compensation, and combined with hours it reconstructs a salary.
drop policy if exists p_people_read on people;
create policy p_people_read on people for select using (
  can_see_compensation() or user_id = current_app_user_id()
);
drop policy if exists p_people_write on people;
create policy p_people_write on people for all using (can_manage_people()) with check (can_manage_people());

drop policy if exists p_time_read on time_entries;
create policy p_time_read on time_entries for select using (
  can_see_compensation()
  or person_id in (select id from people where user_id = current_app_user_id())
  or project_id in (select scoped_project_ids())
);
drop policy if exists p_time_write on time_entries;
create policy p_time_write on time_entries for all using (can_manage_people()) with check (can_manage_people());

-- --- Controls and credentials -----------------------------------------------

drop policy if exists p_integrations_read on integrations;
create policy p_integrations_read on integrations for select using (can_manage_integrations());

drop policy if exists p_alert_rules_read on alert_rules;
create policy p_alert_rules_read on alert_rules for select using (can_see_all_money());
drop policy if exists p_alert_rules_write on alert_rules;
create policy p_alert_rules_write on alert_rules for all using (can_move_money()) with check (can_move_money());

drop policy if exists p_notifications_read on notifications;
create policy p_notifications_read on notifications for select using (can_see_all_money());

drop policy if exists p_imports_read on manual_imports;
create policy p_imports_read on manual_imports for select using (can_categorise());

drop policy if exists p_audit_read on audit_logs;
create policy p_audit_read on audit_logs for select using (can_read_audit());
-- Insert stays open to any signed-in person: the trail records what THEY did,
-- and a role that could act without leaving a record would defeat section 24.
drop policy if exists p_audit_insert on audit_logs;
create policy p_audit_insert on audit_logs for insert with check (is_app_user());
