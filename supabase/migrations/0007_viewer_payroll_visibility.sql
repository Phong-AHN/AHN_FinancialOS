-- ============================================================================
-- A viewer could read payroll. Spec section 23 says they must not.
--
-- The policy asked `is_sensitive_category(category)`, but the categoriser files
-- a payroll run as:
--
--     category    = 'people'
--     subcategory = 'us_payroll' | 'ph_payroll_veem' | 'payroll'
--
-- `'people'` matches none of the sensitive words, so every payroll row was
-- visible to every viewer. Proven against the live database with a real viewer
-- session before this migration, and again after it.
--
-- That is the worst shape a security bug takes: the policy existed, was enabled,
-- and read as though it worked.
--
-- Two changes:
--
--   1. `subcategory` is checked as well as `category`. The payroll signal lives
--      there, so a rule that ignores it can only ever half-work.
--   2. The whole `people` category is sensitive, not just the rows whose text
--      happens to contain "payroll". It holds salaries, contractor payments,
--      commissions and bonuses — spec section 23 calls all of that restricted,
--      and an exact category match cannot drift the way a word list does.
-- ============================================================================

create or replace function is_sensitive_transaction(cat text, subcat text) returns boolean
language sql immutable as $fn$
  select
    -- Everything under People is compensation.
    coalesce(lower(cat) = 'people', false)
    -- Plus anything either column names as pay, wherever it was filed.
    or coalesce(
         lower(coalesce(cat, '') || ' ' || coalesce(subcat, '')) similar to
         '%(payroll|salary|salaries|wage|bonus|commission|compensation|contractor)%',
         false
       );
$fn$;

-- Kept so existing callers do not break, now delegating to the pair-aware rule.
create or replace function is_sensitive_category(cat text) returns boolean
language sql immutable as $fn$
  select is_sensitive_transaction(cat, null);
$fn$;

drop policy if exists p_txn_read on transactions;
create policy p_txn_read on transactions for select using (
  is_owner() or (is_app_user() and not is_sensitive_transaction(category, subcategory))
);
