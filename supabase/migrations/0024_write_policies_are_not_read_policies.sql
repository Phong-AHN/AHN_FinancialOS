-- ============================================================================
-- A write policy must not silently grant reads - Spec sections 23, 25
--
-- THE BUG. Every write policy in 0023 was written `FOR ALL`. In Postgres,
-- `FOR ALL` covers SELECT as well, and RLS policies on a table are OR-ed
-- together — so a permissive `FOR ALL` write policy grants a full table read to
-- anybody it lets write, no matter what the scoped read policy says.
--
-- Effect, found by probing with a real department-lead token: `p_projects_write`
-- allows `can_manage_projects()`, which includes department_lead, so a
-- department lead could read EVERY project — including ones in no unit and
-- owned by nobody — while the read policy beside it carefully restricted them
-- to their own. The scoped read policy was correct and completely bypassed.
--
-- Transactions were unaffected, because their write policy was `FOR UPDATE`.
-- That is the whole difference, and it was an accident rather than a decision.
--
-- THE FIX: write policies say exactly which writes they mean. Reads are
-- decided by the read policy and nothing else.
--
-- Idempotent: safe to re-run. Every new policy is dropped first — a
-- `create policy` without one is a migration that works once and then
-- blocks every migration behind it, which is how 0025 silently never ran.
-- ============================================================================

-- --- Projects, units, clients: where a SCOPED role can write ----------------
--
-- These three are the ones that mattered: `can_manage_projects()` includes
-- department_lead, whose reads are supposed to be limited to their own unit.

drop policy if exists p_projects_write on projects;
drop policy if exists p_projects_insert on projects;
create policy p_projects_insert on projects for insert with check (can_manage_projects());
drop policy if exists p_projects_update on projects;
create policy p_projects_update on projects for update using (can_manage_projects()) with check (can_manage_projects());
drop policy if exists p_projects_delete on projects;
create policy p_projects_delete on projects for delete using (can_move_money());

drop policy if exists p_units_write on business_units;
drop policy if exists p_units_insert on business_units;
create policy p_units_insert on business_units for insert with check (can_manage_projects());
drop policy if exists p_units_update on business_units;
create policy p_units_update on business_units for update using (can_manage_projects()) with check (can_manage_projects());
drop policy if exists p_units_delete on business_units;
create policy p_units_delete on business_units for delete using (can_move_money());

drop policy if exists p_clients_write on clients;
drop policy if exists p_clients_insert on clients;
create policy p_clients_insert on clients for insert with check (can_manage_projects());
drop policy if exists p_clients_update on clients;
create policy p_clients_update on clients for update using (can_manage_projects()) with check (can_manage_projects());
drop policy if exists p_clients_delete on clients;
create policy p_clients_delete on clients for delete using (can_move_money());

-- --- The rest, for the same reason -----------------------------------------
--
-- On these, the write capability happens to be narrower than or equal to the
-- read capability, so `FOR ALL` was not leaking anything today. It is still
-- replaced: the next change to a capability should not be able to reintroduce
-- the bug quietly, and "this one is safe because of how two other functions
-- currently overlap" is not a property worth relying on.

drop policy if exists p_accounts_write on financial_accounts;
drop policy if exists p_accounts_insert on financial_accounts;
create policy p_accounts_insert on financial_accounts for insert with check (can_move_money());
drop policy if exists p_accounts_update on financial_accounts;
create policy p_accounts_update on financial_accounts for update using (can_move_money()) with check (can_move_money());
drop policy if exists p_accounts_delete on financial_accounts;
create policy p_accounts_delete on financial_accounts for delete using (can_move_money());

drop policy if exists p_companies_write on companies;
drop policy if exists p_companies_insert on companies;
create policy p_companies_insert on companies for insert with check (can_move_money());
drop policy if exists p_companies_update on companies;
create policy p_companies_update on companies for update using (can_move_money()) with check (can_move_money());
drop policy if exists p_companies_delete on companies;
create policy p_companies_delete on companies for delete using (can_move_money());

drop policy if exists p_counterparties_write on counterparties;
drop policy if exists p_counterparties_insert on counterparties;
create policy p_counterparties_insert on counterparties for insert with check (can_categorise());
drop policy if exists p_counterparties_update on counterparties;
create policy p_counterparties_update on counterparties for update using (can_categorise()) with check (can_categorise());
drop policy if exists p_counterparties_delete on counterparties;
create policy p_counterparties_delete on counterparties for delete using (can_move_money());

drop policy if exists p_fx_write on exchange_rates;
drop policy if exists p_fx_insert on exchange_rates;
create policy p_fx_insert on exchange_rates for insert with check (can_move_money());
drop policy if exists p_fx_update on exchange_rates;
create policy p_fx_update on exchange_rates for update using (can_move_money()) with check (can_move_money());
drop policy if exists p_fx_delete on exchange_rates;
create policy p_fx_delete on exchange_rates for delete using (can_move_money());

drop policy if exists p_budgets_write on budgets;
drop policy if exists p_budgets_insert on budgets;
create policy p_budgets_insert on budgets for insert with check (can_move_money());
drop policy if exists p_budgets_update on budgets;
create policy p_budgets_update on budgets for update using (can_move_money()) with check (can_move_money());
drop policy if exists p_budgets_delete on budgets;
create policy p_budgets_delete on budgets for delete using (can_move_money());

drop policy if exists p_obligations_write on obligations;
drop policy if exists p_obligations_insert on obligations;
create policy p_obligations_insert on obligations for insert with check (can_move_money());
drop policy if exists p_obligations_update on obligations;
create policy p_obligations_update on obligations for update using (can_move_money()) with check (can_move_money());
drop policy if exists p_obligations_delete on obligations;
create policy p_obligations_delete on obligations for delete using (can_move_money());

drop policy if exists p_alert_rules_write on alert_rules;
drop policy if exists p_alert_rules_insert on alert_rules;
create policy p_alert_rules_insert on alert_rules for insert with check (can_move_money());
drop policy if exists p_alert_rules_update on alert_rules;
create policy p_alert_rules_update on alert_rules for update using (can_move_money()) with check (can_move_money());
drop policy if exists p_alert_rules_delete on alert_rules;
create policy p_alert_rules_delete on alert_rules for delete using (can_move_money());

-- Compensation. `can_manage_people()` is narrower than `can_see_compensation()`
-- so nothing leaked here either, but an employee reading their OWN record is
-- exactly the kind of narrow read a stray FOR ALL would widen.
drop policy if exists p_people_write on people;
drop policy if exists p_people_insert on people;
create policy p_people_insert on people for insert with check (can_manage_people());
drop policy if exists p_people_update on people;
create policy p_people_update on people for update using (can_manage_people()) with check (can_manage_people());
drop policy if exists p_people_delete on people;
create policy p_people_delete on people for delete using (can_manage_people());

drop policy if exists p_time_write on time_entries;
drop policy if exists p_time_insert on time_entries;
create policy p_time_insert on time_entries for insert with check (can_manage_people());
drop policy if exists p_time_update on time_entries;
create policy p_time_update on time_entries for update using (can_manage_people()) with check (can_manage_people());
drop policy if exists p_time_delete on time_entries;
create policy p_time_delete on time_entries for delete using (can_manage_people());
