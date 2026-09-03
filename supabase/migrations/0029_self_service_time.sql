-- ============================================================================
-- Logging your own hours - Spec section 13
--
-- Time entries could only be written by `can_manage_people()`, so an employee
-- could see their hours and not add to them. In practice that means the owner
-- types everybody's timesheet, which means nobody's timesheet gets typed —
-- which is why `time_entries` is empty and why every project margin in the app
-- carries the caveat that labour is not counted. Section 12's whole premise is
-- that a project staffed by three people should not look as profitable as one
-- nobody touched.
--
-- TWO THINGS WERE MISSING, and only the first is obvious.
--
--   1. Write access to your own rows.
--   2. Something to log time AGAINST. An `employee` owns no project and leads
--      no unit, so `scoped_project_ids()` returns nothing and they could not
--      see a single project to pick. Self-service time entry was impossible on
--      that ground alone.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- --- 1. A picker that shows names without showing contract values ------------
--
-- `projects` carries `contracted_revenue_minor`, `invoiced_revenue_minor` and
-- `budget_expense_minor`. An employee choosing what to log against needs the
-- name and nothing else, and RLS is row-level: it cannot hand back a subset of
-- the columns. So the restriction is expressed as a view over the safe columns.
--
-- It deliberately runs as its owner rather than as the caller (the default),
-- because the point is to bypass `p_projects_read` and substitute a narrower
-- rule — signed-in app users, open projects, no money. Anything commercially
-- sensitive stays behind the table's own policy.
create or replace view projects_for_time as
  select p.id, p.name, p.code, p.kind, p.status, p.business_unit_id
  from projects p
  where is_app_user()
    and p.status in ('planned', 'active');

comment on view projects_for_time is
  'Spec 13. Project names for a timesheet picker. No revenue, budget or margin column appears here by design.';

grant select on projects_for_time to authenticated;

-- --- 2. Writing your own hours ----------------------------------------------
--
-- `person_id in (select id from people where user_id = current_app_user_id())`
-- is what keeps this honest: it is both "may I write" and "may I write AS this
-- person". Without the second half an employee could log hours against a
-- colleague and change that colleague's cost.
--
-- THE DATE WINDOW. Hours feed project profitability, so a timesheet rewritten
-- months later silently restates a margin somebody has already reported. Self
-- service is limited to the last 14 days; owner and CFO stay unrestricted,
-- because correcting an old entry is exactly their job.
--
-- The `+ 1` on the upper bound is not slack, it is a timezone. The database
-- clock is UTC and AHN works in UTC+7, so between midnight and 07:00 in Vietnam
-- "today" is already tomorrow by `current_date` — see decision 84. Without it,
-- somebody logging Thursday's hours on Thursday morning would be told Thursday
-- is in the future.
create or replace function may_log_own_time(the_person uuid, the_date date)
returns boolean language sql stable as $fn$
  select the_person in (select id from people where user_id = current_app_user_id())
     and the_date <= current_date + 1
     and the_date >= current_date - 14;
$fn$;

drop policy if exists p_time_insert on time_entries;
create policy p_time_insert on time_entries for insert
  with check (can_manage_people() or may_log_own_time(person_id, work_date));

drop policy if exists p_time_update on time_entries;
create policy p_time_update on time_entries for update
  using (can_manage_people() or may_log_own_time(person_id, work_date))
  with check (can_manage_people() or may_log_own_time(person_id, work_date));

drop policy if exists p_time_delete on time_entries;
create policy p_time_delete on time_entries for delete
  using (can_manage_people() or may_log_own_time(person_id, work_date));

-- The read policy already covers this case (`person_id in (... user_id =
-- current_app_user_id())` from 0023) and is left alone.

comment on function may_log_own_time(uuid, date) is
  'Spec 13. True when this row is the caller''s own and recent enough to be self-served.';
