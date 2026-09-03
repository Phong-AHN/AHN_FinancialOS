-- ============================================================================
-- Finverse as a Vietnamese bank connector - Spec section 2
--
-- Neither Vietnamese bank AHN uses offers a route we can take today:
-- VietinBank's sandbox needs a registered application, and Techcombank has no
-- public self-serve sandbox at all. Finverse is an aggregator that already
-- covers Techcombank, Vietcombank and VP Bank, and it does have a sandbox with
-- documented, versioned client libraries - which means the contract can be read
-- rather than guessed.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_enum
    where enumtypid = 'source_system'::regtype and enumlabel = 'finverse'
  ) then
    alter type source_system add value 'finverse';
  end if;

  if not exists (
    select 1 from pg_enum
    where enumtypid = 'integration_provider'::regtype and enumlabel = 'finverse'
  ) then
    alter type integration_provider add value 'finverse';
  end if;
end $$;
