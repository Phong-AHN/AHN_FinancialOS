-- ============================================================================
-- Budget vs. actual - Spec section 19
--
-- Section 19 asks for budgets "at company, department, business-unit, event,
-- client, and project levels". One table with a scope type and a nullable
-- scope id covers all of them; six tables would mean six copies of the same
-- variance arithmetic, and the sixth would drift.
--
-- BUDGETS ARE PERIOD-BOUND, and that is not incidental. Section 19 also asks
-- for a "projected final cost" and for alerts "before overspend occurs" -
-- neither of which means anything without a period to be partway through.
--
-- The lifetime budget already on `projects.budget_expense_minor` is a different
-- thing: what a fixed piece of work is allowed to cost in total. Both can exist
-- for one project, so `budgets.md` on the page detects it and says so rather
-- than letting two numbers disagree in silence.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'budget_scope') then
    create type budget_scope as enum (
      'company',
      'business_unit',
      'client',
      'project',
      -- "department" in section 15 is a business unit here; a category budget
      -- is what actually gets used for opex ("marketing, 40m a quarter").
      'category',
      -- No scope id: the whole company's operating spend.
      'total'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'budget_period') then
    create type budget_period as enum ('month', 'quarter', 'year');
  end if;
end $$;

create table if not exists budgets (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  scope         budget_scope not null,

  -- Which company / unit / client / project. Null for 'total', and for
  -- 'category' the category name lives in `scope_key` instead: categories are
  -- text in `transactions`, not rows with ids.
  scope_id      uuid,
  scope_key     text,

  period        budget_period not null default 'month',
  -- The first day of the period. Its end is derived, so a month budget cannot
  -- be stored with an end date that is not the end of that month.
  starts_on     date not null,

  amount_minor  bigint not null check (amount_minor >= 0),
  currency      char(3) not null default 'USD',

  notes         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A scope that needs a target must have one, and one that does not must not.
  -- Without this a 'project' budget with a null id silently becomes a second
  -- company-wide budget.
  constraint budgets_scope_target check (
    (scope in ('company', 'business_unit', 'client', 'project') and scope_id is not null and scope_key is null)
    or (scope = 'category' and scope_key is not null and scope_id is null)
    or (scope = 'total' and scope_id is null and scope_key is null)
  ),

  -- One budget per scope per period. A second one for the same month is an
  -- edit, not an addition; without this the page would show two figures and
  -- neither would be wrong.
  unique (scope, scope_id, scope_key, period, starts_on)
);

create index if not exists idx_budgets_period on budgets(starts_on desc, period);
create index if not exists idx_budgets_scope  on budgets(scope, scope_id);

-- --- RLS --------------------------------------------------------------------
alter table budgets enable row level security;

-- A budget is a plan, not compensation: any signed-in person may read one.
-- Setting it is a financial control, so writing is the owner's.
drop policy if exists p_budgets_read on budgets;
create policy p_budgets_read on budgets for select using (is_app_user());
drop policy if exists p_budgets_write on budgets;
create policy p_budgets_write on budgets for all using (is_owner()) with check (is_owner());
