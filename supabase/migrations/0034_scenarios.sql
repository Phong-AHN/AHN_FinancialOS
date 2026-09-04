-- ============================================================================
-- Saved scenarios - Spec section 11
--
-- Section 11 asks for base, conservative, aggressive and custom cases. Those
-- exist and are recomputed on every page load; what was missing is keeping one,
-- so AHN can say "this is the plan we agreed in September" and check it later.
--
-- IT WAS DELIBERATELY NOT BUILT until the labelling question was answered, and
-- the answer shapes this table:
--
--   1. **The INPUTS are stored. The OUTPUTS are not.** A saved scenario keeps
--      the growth rate, the horizon and the margin target; the numbers are
--      recomputed from them every time it is read. Storing computed figures
--      would freeze them against whatever the engine did that month, and the
--      first improvement to the arithmetic would leave a stored plan quietly
--      disagreeing with a fresh one built from identical inputs.
--
--   2. **The BASELINE it was built on is stored too.** A plan made in June
--      compounded June's revenue. Re-running it against today's baseline would
--      silently change the plan somebody agreed to. Keeping the baseline is
--      what makes a saved scenario a record rather than a live query.
--
--   3. **Nothing here is ever an actual.** There is no status, no "approved",
--      no link to a transaction. A scenario is a projection, it is labelled as
--      one wherever it is shown, and no page adds it to a real figure.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists scenarios (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,

  -- --- The inputs, which are the scenario ---------------------------------
  -- Month-over-month revenue growth, as a ratio: 0.15 is +15%.
  revenue_growth_rate  numeric(8,5) not null,
  expense_growth_rate  numeric(8,5) not null,
  months               integer not null check (months between 1 and 60),
  -- Null when the scenario is a growth projection rather than a margin target.
  target_margin_ratio  numeric(8,5),
  -- 'net' measures against all operating spend, 'gross' against cost of
  -- delivery only. The same target means very different revenue (decision 93).
  margin_basis         text check (margin_basis in ('net', 'gross')),

  -- --- The baseline it was built on, frozen ------------------------------
  -- Not a foreign key to anything: it is a photograph of what the company
  -- looked like the day the plan was made.
  baseline_revenue_usd_minor bigint not null,
  baseline_expense_usd_minor bigint not null,
  baseline_months_sampled    integer not null,
  baseline_as_of             date not null,

  notes          text,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),

  -- Two plans may share a name across time; the same name twice on the same
  -- day is a double-submitted form.
  unique (name, created_at)
);

create index if not exists idx_scenarios_created on scenarios(created_at desc);

-- --- RLS --------------------------------------------------------------------
alter table scenarios enable row level security;

-- A scenario is a revenue plan: it carries no compensation and no counterparty,
-- so anyone trusted with the company's money picture may read one.
drop policy if exists p_scenarios_read on scenarios;
create policy p_scenarios_read on scenarios for select using (can_see_all_money());

-- Writing one is planning, which is a finance role's job.
drop policy if exists p_scenarios_insert on scenarios;
create policy p_scenarios_insert on scenarios for insert with check (can_move_money());
drop policy if exists p_scenarios_update on scenarios;
create policy p_scenarios_update on scenarios for update using (can_move_money()) with check (can_move_money());
drop policy if exists p_scenarios_delete on scenarios;
create policy p_scenarios_delete on scenarios for delete using (can_move_money());

comment on table scenarios is
  'Spec 11. A saved PROJECTION, never an actual. Inputs and the baseline are stored; every figure is recomputed on read.';
