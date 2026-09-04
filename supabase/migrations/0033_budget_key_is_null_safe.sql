-- ============================================================================
-- A budget's natural key has to match itself - Spec section 19
--
-- `unique (scope, scope_id, scope_key, period, starts_on)` looked like it made
-- a budget unique per scope and period. It did not, and the gap was invisible.
--
-- `scope_id` is NULL for the two most common kinds of budget: a category
-- budget and a company-wide one. Postgres treats NULLs as DISTINCT in a unique
-- constraint, so those rows never conflict with themselves — every save created
-- another budget, and `on conflict` in the create route matched nothing and
-- silently inserted.
--
-- The live database was carrying six identical rows because of it. The visible
-- symptom would have been worse than duplicates in a table: `/budgets` sums
-- what the company planned, so saving a $7,500 marketing budget twice told AHN
-- it had planned $15,000.
--
-- NULLS NOT DISTINCT (Postgres 15+) makes the key mean what it always claimed
-- to mean. The columns are unchanged, so `on conflict (scope, scope_id,
-- scope_key, period, starts_on)` in the route now finds the row instead of
-- inserting beside it — the create route becomes an edit, which is what
-- decision 91's project editing already assumed budgets could do.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table budgets drop constraint if exists budgets_scope_scope_id_scope_key_period_starts_on_key;
alter table budgets drop constraint if exists budgets_natural_key;

alter table budgets
  add constraint budgets_natural_key
  unique nulls not distinct (scope, scope_id, scope_key, period, starts_on);
