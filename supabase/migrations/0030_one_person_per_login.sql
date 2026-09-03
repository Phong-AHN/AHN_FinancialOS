-- ============================================================================
-- One login is one person - Spec section 13
--
-- `people.user_id` has existed since 0013 with no constraint on it, which was
-- survivable while nothing read it. Migration 0029 made it the thing that
-- decides whose timesheet you are filling in, and an ambiguous answer to
-- "which person am I?" is a person logging hours against somebody else's cost.
--
-- Two `people` rows pointing at one login would make `may_log_own_time` true
-- for both of them, and the timesheet page would pick whichever the database
-- happened to return first.
--
-- Not partial. Postgres treats nulls as distinct in a unique index, so any
-- number of people with no login coexist under a plain one — most of AHN's
-- contractors will never have a login at all. A `where user_id is not null`
-- predicate would add nothing and, as migration 0027 found the hard way, would
-- stop the index being usable as an `on conflict` target later.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create unique index if not exists idx_people_user on people(user_id);

comment on column people.user_id is
  'The login this person fills in timesheets with. Null for anyone who has no login, which is most contractors.';
