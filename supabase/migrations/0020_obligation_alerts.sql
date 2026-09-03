-- ============================================================================
-- Overdue and upcoming alerts - Spec sections 17 and 18
--
-- Split from 0019: Postgres will not let a transaction use an enum value added
-- in that same transaction.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_enum
    where enumtypid = 'alert_type'::regtype and enumlabel = 'overdue_receivable'
  ) then
    alter type alert_type add value 'overdue_receivable';
  end if;

  if not exists (
    select 1 from pg_enum
    where enumtypid = 'alert_type'::regtype and enumlabel = 'upcoming_obligation'
  ) then
    alter type alert_type add value 'upcoming_obligation';
  end if;
end $$;
