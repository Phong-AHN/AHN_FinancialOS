-- ============================================================================
-- A department lead writes inside their own unit - Spec section 23
--
-- 0024 stopped write policies from granting reads. Probing the result showed a
-- second, quieter problem: `can_manage_projects()` let a department lead create
-- a project in ANY unit, or in none at all — and then the scoped read policy
-- correctly refused to show it back to them.
--
-- A row somebody can create and cannot then see is not a permission model, it
-- is a trap. Write scope now matches read scope: a department lead may create
-- and edit projects in a unit they lead, and nothing else. Owner and CFO keep
-- the unrestricted path.
--
-- Idempotent: safe to re-run.
-- ============================================================================

/** A unit this reader leads. */
create or replace function leads_unit(unit uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from business_units
    where id = unit and lead_user_id = current_app_user_id()
  );
$fn$;

drop policy if exists p_projects_insert on projects;
create policy p_projects_insert on projects for insert with check (
  can_move_money() or leads_unit(business_unit_id)
);

drop policy if exists p_projects_update on projects;
create policy p_projects_update on projects for update
  using (can_move_money() or leads_unit(business_unit_id))
  -- Checked on the NEW row as well, so a lead cannot move a project out of
  -- their unit and keep editing it, nor pull one in that was never theirs.
  with check (can_move_money() or leads_unit(business_unit_id));

-- Business units and clients are company-wide reference data. A department
-- lead leads a unit; they do not get to create new ones or rename another
-- lead's. That was over-granted in 0023 and is corrected here rather than
-- left because it happened to be written down once.
drop policy if exists p_units_insert on business_units;
create policy p_units_insert on business_units for insert with check (can_move_money());
drop policy if exists p_units_update on business_units;
create policy p_units_update on business_units for update
  using (can_move_money() or leads_unit(id))
  with check (can_move_money() or leads_unit(id));

drop policy if exists p_clients_insert on clients;
create policy p_clients_insert on clients for insert with check (can_manage_projects());
