-- ============================================================================
-- VEEM as an API integration - Spec section 2
--
-- Section 2 lists VEEM among the required integrations, "especially for
-- Philippines payroll", and section 18 names VEEM payments as a commitment to
-- track before the money goes. Until now the only route in was a CSV export
-- somebody downloaded and uploaded, which means the ledger was as current as
-- the last time a person remembered to do it.
--
-- `csv_veem` already exists as a source and stays: a file exported last quarter
-- is still a legitimate record of what happened, and rewriting its provenance
-- to say "api" would be a lie about where those rows came from.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_enum
    where enumtypid = 'integration_provider'::regtype and enumlabel = 'veem'
  ) then
    alter type integration_provider add value 'veem';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_enum
    where enumtypid = 'source_system'::regtype and enumlabel = 'veem'
  ) then
    alter type source_system add value 'veem';
  end if;
end $$;
