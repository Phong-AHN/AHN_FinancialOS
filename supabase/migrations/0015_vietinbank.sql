-- ============================================================================
-- VietinBank iConnect as a direct source - Spec section 2
--
-- The corporate ERP Statement API, distinct from `finverse`: the aggregator
-- reaches individual accounts only, this one reaches the company's.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_enum
    where enumtypid = 'source_system'::regtype and enumlabel = 'vietinbank'
  ) then
    alter type source_system add value 'vietinbank';
  end if;

  if not exists (
    select 1 from pg_enum
    where enumtypid = 'integration_provider'::regtype and enumlabel = 'vietinbank'
  ) then
    alter type integration_provider add value 'vietinbank';
  end if;
end $$;
