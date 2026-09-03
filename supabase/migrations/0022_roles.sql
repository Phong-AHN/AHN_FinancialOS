-- ============================================================================
-- The seven roles - Spec section 23
--
-- Week 1 shipped owner and viewer. Section 23 asks for seven, and a financial
-- system for a group cannot run on "everyone who is not the CEO sees
-- everything except payroll".
--
-- WHY CAPABILITIES RATHER THAN ROLE NAMES IN POLICIES.
--
-- There are ~28 policies. Written as `role in ('owner','cfo','accountant')`,
-- every future change to who may do what means editing 28 places and getting
-- all 28 right. One missed policy is a silent hole that no test would notice,
-- because a policy that grants too much still returns rows.
--
-- So the matrix lives in ONE function per capability, and every policy asks a
-- question about the action rather than about the person: "may this reader see
-- compensation?", not "is this reader one of these three roles?".
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  -- Postgres has no "add several enum values atomically", so each is guarded.
  if not exists (select 1 from pg_enum where enumtypid = 'user_role'::regtype and enumlabel = 'cfo') then
    alter type user_role add value 'cfo';
  end if;
  if not exists (select 1 from pg_enum where enumtypid = 'user_role'::regtype and enumlabel = 'accountant') then
    alter type user_role add value 'accountant';
  end if;
  if not exists (select 1 from pg_enum where enumtypid = 'user_role'::regtype and enumlabel = 'department_lead') then
    alter type user_role add value 'department_lead';
  end if;
  if not exists (select 1 from pg_enum where enumtypid = 'user_role'::regtype and enumlabel = 'project_manager') then
    alter type user_role add value 'project_manager';
  end if;
  if not exists (select 1 from pg_enum where enumtypid = 'user_role'::regtype and enumlabel = 'employee') then
    alter type user_role add value 'employee';
  end if;
end $$;

-- A department lead is scoped to their unit, so the unit has to know who leads
-- it. Nullable: most units will not have one until somebody says so.
alter table business_units
  add column if not exists lead_user_id uuid references users(id) on delete set null;

create index if not exists idx_units_lead on business_units(lead_user_id);
