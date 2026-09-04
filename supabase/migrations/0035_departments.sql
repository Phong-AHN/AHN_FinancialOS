-- ============================================================================
-- Department budgets - Spec section 19
--
-- Section 19 names "department" as a budget level. The closest thing that
-- existed was `business_unit`, and for AHN those are revenue lines - Membership,
-- Labs, Agency - not functions. A marketing budget has nowhere to live.
--
-- A DEPARTMENT IS A GROUP OF SPEND CATEGORIES, not a new tag on every
-- transaction.
--
-- The obvious design is a `department_id` column on `transactions`, and it is
-- the wrong one: it would ask AHN to attribute every row a second time, on top
-- of projects, before a single budget could be measured - and nothing has been
-- attributed yet. The section 7 taxonomy already classifies every transaction.
-- "Marketing spent $4,000 against a $5,000 budget" is answerable today if a
-- department simply owns its categories.
--
-- A CATEGORY BELONGS TO AT MOST ONE DEPARTMENT, enforced below. Two departments
-- both claiming `software` would count the same dollar against both budgets and
-- the company total would stop adding up.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists departments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  -- Section 7 category keys this department owns, e.g. {marketing, events}.
  categories  text[] not null default '{}',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists idx_departments_order on departments(sort_order, name);

/**
 * No category may be owned twice.
 *
 * Written as a trigger rather than a constraint because the rule is across
 * rows, not within one: an exclusion constraint on an array cannot express
 * "these elements appear in no other row".
 */
create or replace function departments_own_distinct_categories() returns trigger
language plpgsql as $fn$
declare
  clash text;
begin
  select c into clash
  from unnest(new.categories) as c
  where exists (
    select 1 from departments d
    where d.id <> new.id and c = any(d.categories)
  )
  limit 1;

  if clash is not null then
    raise exception
      'Category "%" already belongs to another department. One category, one department, or the same spending is counted against two budgets.', clash;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_departments_distinct on departments;
create trigger trg_departments_distinct
  before insert or update on departments
  for each row execute function departments_own_distinct_categories();

-- --- The budget scope -------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_enum
    where enumtypid = 'budget_scope'::regtype and enumlabel = 'department'
  ) then
    alter type budget_scope add value 'department';
  end if;
end $$;

-- --- RLS --------------------------------------------------------------------
alter table departments enable row level security;

-- A department is a label over categories: no money, no compensation.
drop policy if exists p_departments_read on departments;
create policy p_departments_read on departments for select using (is_app_user());
drop policy if exists p_departments_write on departments;
create policy p_departments_write on departments for all using (can_move_money()) with check (can_move_money());

comment on table departments is
  'Spec 19. A department owns section 7 spend categories, so department spend is answerable without tagging every transaction again.';
