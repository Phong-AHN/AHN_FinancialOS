-- ============================================================================
-- Overspend alerts - Spec section 19 ("alerts before overspend occurs")
--
-- Split from 0016 because Postgres will not let a transaction use an enum
-- value added in that same transaction.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_enum
    where enumtypid = 'alert_type'::regtype and enumlabel = 'budget_overspend'
  ) then
    alter type alert_type add value 'budget_overspend';
  end if;
end $$;
