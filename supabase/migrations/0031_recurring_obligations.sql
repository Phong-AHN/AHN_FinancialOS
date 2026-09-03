-- ============================================================================
-- Commitments that come round again - Spec section 18
--
-- Section 18 is about knowing what is coming BEFORE money leaves the bank, and
-- its own examples are almost all recurring: payroll, VEEM payments, legal
-- retainers, accounting fees, taxes, software renewals. `is_recurring` recorded
-- that a commitment repeats and nothing ever acted on it, so "cash after
-- commitments" only ever saw the instances somebody had typed by hand. Next
-- month's payroll was invisible until the day it was entered.
--
-- WHY A CADENCE COLUMN RATHER THAN A BOOLEAN. `is_recurring` says a thing
-- repeats without saying when, which is not enough to generate anything.
-- Existing rows keep their flag and get a null cadence: they are "recurring,
-- cadence unknown", and nothing is generated for them rather than a monthly
-- rhythm being invented on their behalf.
--
-- `generated_from_id` points at the template, and the unique index over
-- (generated_from_id, due_on) is what makes generation idempotent — a job that
-- runs daily must not create thirty copies of March's rent.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'obligation_recurrence') then
    create type obligation_recurrence as enum ('monthly', 'quarterly', 'annual');
  end if;
end $$;

alter table obligations
  add column if not exists recurrence obligation_recurrence,
  -- When to stop. Null means "until somebody says otherwise", which is how a
  -- payroll commitment actually behaves.
  add column if not exists recurs_until date,
  add column if not exists generated_from_id uuid references obligations(id) on delete cascade;

-- One generated instance per template per due date.
create unique index if not exists idx_obligations_generated
  on obligations(generated_from_id, due_on);

create index if not exists idx_obligations_recurrence
  on obligations(recurrence, due_on)
  where recurrence is not null;

comment on column obligations.recurrence is
  'Spec 18. How often this commitment repeats. Null means it does not, or that nobody has said how often.';
comment on column obligations.generated_from_id is
  'The recurring template this instance was generated from. Null for anything entered by hand.';
