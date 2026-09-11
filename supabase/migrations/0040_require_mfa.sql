-- Two-factor authentication, enforced by the database.
--
-- The application sends anybody without a second factor to set one up
-- (`src/lib/auth.ts`). That is routing. THIS is the boundary: every table in
-- the schema refuses a session that has not completed two-factor sign-in, so a
-- password on its own — phished, reused, typed into the wrong window — reads
-- nothing, whether it is used through this application or straight against the
-- Supabase API with the public anon key.
--
-- HOW. Supabase stamps every access token with `aal`: `aal1` after a password
-- or an emailed link, `aal2` once a TOTP code has been verified in the same
-- session. A RESTRICTIVE policy is ANDed with every permissive one, so it adds
-- a condition to all the existing rules without rewriting any of them: the
-- role checks still decide WHAT somebody may see; this decides whether they
-- have signed in properly enough to see anything.
--
-- WHAT IT DOES NOT TOUCH. The service role bypasses RLS, so the scheduler, the
-- OAuth callback's writes and the Slack commands — each authenticated by its
-- own secret, not by a user session — carry on exactly as before.
--
-- VERIFIED BEFORE IT WAS WRITTEN: a throwaway user's token says `aal1` after a
-- password and `aal2` after `mfa.challengeAndVerify`, on this project.

create or replace function public.mfa_verified()
returns boolean
language sql
stable
set search_path = ''
as $$
  -- `(select …)` so Postgres evaluates the claim once per statement rather
  -- than once per row, which is Supabase's own guidance for RLS helpers.
  select coalesce((select auth.jwt() ->> 'aal') = 'aal2', false);
$$;

comment on function public.mfa_verified() is
  'True when the caller signed in with two factors (JWT aal = aal2). Used by p_require_mfa on every table.';

-- Every table in the schema, including any added before this migration runs.
-- A table created LATER does not get this automatically — Postgres cannot
-- attach a policy on creation without an event trigger, which Supabase does not
-- allow here — so tests/mfa.integration.test.ts fails for any table without it.
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('drop policy if exists p_require_mfa on public.%I', r.relname);
    execute format(
      'create policy p_require_mfa on public.%I as restrictive for all to authenticated '
      'using (public.mfa_verified()) with check (public.mfa_verified())',
      r.relname
    );
  end loop;
end
$$;

-- The one view. It runs with its owner's rights, so the policies above do not
-- reach through it to `projects`; without this clause a password alone would
-- still list every active project's name. The same `is_app_user()` filter it
-- always had, plus the second factor.
create or replace view public.projects_for_time as
  select p.id, p.name, p.code, p.kind, p.status, p.business_unit_id
  from public.projects p
  where public.is_app_user()
    and public.mfa_verified()
    and p.status in ('planned', 'active');
