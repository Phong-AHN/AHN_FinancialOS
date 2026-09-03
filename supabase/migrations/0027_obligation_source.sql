-- ============================================================================
-- Where an obligation came from - Spec sections 17 and 18
--
-- Obligations were typed in by hand, so they needed no provenance. Pulling
-- invoices and bills from QuickBooks changes that: a sync that runs every ten
-- minutes must be able to find the row it wrote last time, or it writes it
-- again, and AHN is owed the same $40,000 six times before lunch.
--
-- `external_id` is QuickBooks' own id for the invoice or bill. The unique index
-- over (source_system, external_id) is what makes the sync idempotent - it is
-- the same shape the transactions table uses for the same reason.
--
-- NOT partial, and that matters twice over.
--
-- A `where external_id is not null` predicate was the first attempt, on the
-- assumption that hand-entered obligations would otherwise compete for a single
-- null slot. They would not: Postgres treats nulls as distinct in a unique
-- index, so any number of manual rows with no external id coexist happily under
-- a plain one.
--
-- And a partial index cannot be named by `on conflict (source_system,
-- external_id)` - Postgres cannot prove the statement only touches the indexed
-- subset, so it answers "there is no unique or exclusion constraint matching
-- the ON CONFLICT specification" and every upsert fails.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table obligations add column if not exists source_system source_system not null default 'manual';
alter table obligations add column if not exists external_id text;

-- Drop the partial version if an earlier run of this file created it.
drop index if exists idx_obligations_external;

create unique index if not exists idx_obligations_external
  on obligations(source_system, external_id);

create index if not exists idx_obligations_source on obligations(source_system);

comment on column obligations.external_id is
  'The provider''s own id for this invoice or bill. Null for anything entered by hand.';
