-- ============================================================================
-- Price-increase alerts - Spec section 8
--
-- The recurring-charge detector already finds price rises. Until now nothing
-- told anyone: the increase was visible to whoever opened /subscriptions, and
-- a price rise nobody opens a page to discover is a price rise that is simply
-- paid, month after month.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- 1. The new alert type.
do $$
begin
  if not exists (
    select 1 from pg_enum
    where enumtypid = 'alert_type'::regtype and enumlabel = 'price_increase'
  ) then
    alter type alert_type add value 'price_increase';
  end if;
end $$;
