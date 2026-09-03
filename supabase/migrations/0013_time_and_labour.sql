-- ============================================================================
-- Time tracking and labour cost - Spec section 13
--
-- Section 13 names three costing bases: loaded hourly cost, salary allocation,
-- and contractor rate. All three resolve to one number - what an hour of this
-- person costs the company - so `people` stores the basis and the calculator
-- derives the hourly figure. A salaried person's hour is their annual loaded
-- cost divided by the hours they are actually available, which is why
-- `annual_hours` is a column and not the constant 2,080 baked into a formula.
--
-- THE TRAP THIS SCHEMA HAS TO MAKE VISIBLE: payroll is ALREADY in the ledger,
-- as outflows to Gusto. Labour cost computed from time entries is an
-- ALLOCATION of money that has already left the bank once. If a payroll
-- transaction is also attributed to a project directly, that project counts the
-- same dollar twice. Nothing in the database can prevent that, so the
-- calculator detects it and the page says so.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'person_kind') then
    create type person_kind as enum ('employee', 'contractor');
  end if;
  if not exists (select 1 from pg_type where typname = 'cost_basis') then
    -- Mirrors the three bases named in spec section 13.
    create type cost_basis as enum ('salaried', 'hourly', 'contractor_rate');
  end if;
end $$;

create table if not exists people (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  email        text,
  kind         person_kind not null default 'employee',
  basis        cost_basis not null default 'salaried',

  -- Loaded cost: salary plus employer taxes, benefits and anything else the
  -- person costs. Section 13 says "loaded", and an unloaded salary understates
  -- a real employee by roughly a fifth.
  annual_cost_minor  bigint check (annual_cost_minor >= 0),
  hourly_cost_minor  bigint check (hourly_cost_minor >= 0),

  -- Working hours a year for a salaried person. 1,880 is a full-time year after
  -- holiday and leave; 2,080 is the same year with none taken. Which one is
  -- right is a company decision, not a constant.
  annual_hours numeric(8,2) not null default 1880,

  currency     char(3) not null default 'USD',
  is_active    boolean not null default true,
  user_id      uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- A costing basis without its number produces a silent zero for every hour
  -- that person logs, which is worse than refusing the row.
  constraint people_has_a_rate check (
    (basis = 'salaried' and annual_cost_minor is not null and annual_hours > 0)
    or (basis in ('hourly', 'contractor_rate') and hourly_cost_minor is not null)
  )
);

create index if not exists idx_people_active on people(is_active, name);

create table if not exists time_entries (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references people(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  work_date  date not null,
  hours      numeric(6,2) not null check (hours > 0 and hours <= 24),
  notes      text,
  created_at timestamptz not null default now(),
  -- One row per person per project per day. A second entry for the same day is
  -- an edit, not an addition; without this a double-submitted form doubles
  -- somebody's cost.
  unique (person_id, project_id, work_date)
);

create index if not exists idx_time_project on time_entries(project_id, work_date desc);
create index if not exists idx_time_person  on time_entries(person_id, work_date desc);

-- Section 13 reports estimated hours and a labour budget against the actuals.
alter table projects
  add column if not exists estimated_hours     numeric(10,2) check (estimated_hours >= 0),
  add column if not exists labour_budget_minor bigint check (labour_budget_minor >= 0);

-- --- RLS --------------------------------------------------------------------
alter table people       enable row level security;
alter table time_entries enable row level security;

-- What a person costs IS compensation, and spec 23 restricts that to the owner.
-- Viewers can see neither the rates nor the rows: a viewer able to read
-- `people` could divide a project's labour cost by its hours and recover a
-- salary the payroll policy exists to hide.
drop policy if exists p_people_read on people;
create policy p_people_read on people for select using (is_owner());
drop policy if exists p_people_write on people;
create policy p_people_write on people for all using (is_owner()) with check (is_owner());

-- Hours alone are not compensation, but combined with `people` they would be.
-- Restricted for the same reason, and because who worked on what is personnel
-- data in its own right.
drop policy if exists p_time_read on time_entries;
create policy p_time_read on time_entries for select using (is_owner());
drop policy if exists p_time_write on time_entries;
create policy p_time_write on time_entries for all using (is_owner()) with check (is_owner());
