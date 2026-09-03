-- ============================================================================
-- Changing somebody's role, from the app - Spec section 23
--
-- Roles could only be set with SQL or by the create-user script, and after
-- migration 0026 the same was true of linking a Slack account. Both are on
-- AHN's checklist as "run this UPDATE", which is a poor way to hand out
-- permissions: no audit trail, no guard rails, and it needs the one credential
-- that can do anything.
--
-- `users` had a read policy and NO write policy at all, so the only way to
-- change a role was the service role - which bypasses RLS entirely and would
-- have made an API route the only thing standing between an employee and the
-- owner role. Every other permission in this system is proved at the database.
-- This one is now too.
--
-- Three things a policy alone cannot express are enforced by a trigger, because
-- a route check is only as good as the route:
--
--   1. Nobody changes their OWN role. Otherwise the entire model is advisory:
--      any role that can manage people can promote itself, and any owner can
--      demote itself out of the company by accident.
--   2. The last owner cannot be demoted. An organisation with no owner has
--      nobody who can appoint one, and the only way back is the SQL console
--      this migration exists to avoid.
--   3. `auth_id` and `email` are not editable here. Re-pointing a row's
--      `auth_id` at a different login would hand that login this row's role,
--      which is the same privilege escalation by a quieter route.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- --- Read: a CFO manages people, so a CFO can see them -----------------------
-- 0002 wrote this as `is_owner()`, before the seven roles existed. Left alone,
-- `can_manage_people()` includes the CFO but the CFO cannot see the roster they
-- are supposed to manage.
drop policy if exists p_users_read on users;
create policy p_users_read on users for select using (
  can_manage_people() or auth_id = auth.uid()
);

-- --- Write -------------------------------------------------------------------
drop policy if exists p_users_update on users;
create policy p_users_update on users for update
  using (can_manage_people())
  with check (can_manage_people());

/**
 * The invariants.
 *
 * SECURITY DEFINER so the last-owner count is not itself filtered by the read
 * policy of whoever is asking - a CFO counting owners under their own RLS would
 * see the right number here, but relying on that is the kind of assumption that
 * quietly stops being true when a policy changes.
 */
create or replace function guard_user_role_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  actor uuid := current_app_user_id();
  remaining_owners int;
begin
  -- Identity columns are not editable through this path at all.
  if new.auth_id is distinct from old.auth_id then
    raise exception 'auth_id cannot be changed: it decides which login this role belongs to';
  end if;
  if new.email is distinct from old.email then
    raise exception 'email cannot be changed here; it is the identity the login was created with';
  end if;

  if new.role is distinct from old.role then
    -- 1. No self-promotion, and no accidental self-demotion either.
    if actor is not null and new.id = actor then
      raise exception 'You cannot change your own role. Ask another owner.';
    end if;

    -- 2. Somebody must still be the owner afterwards.
    if old.role = 'owner' and new.role <> 'owner' then
      select count(*) into remaining_owners from users where role = 'owner' and id <> old.id;
      if remaining_owners = 0 then
        raise exception 'This is the last owner. Appoint another owner first.';
      end if;
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_guard_user_role_change on users;
create trigger trg_guard_user_role_change
  before update on users
  for each row execute function guard_user_role_change();

comment on function guard_user_role_change() is
  'Spec 23. Blocks self-role-changes, removing the last owner, and re-pointing auth_id/email.';
