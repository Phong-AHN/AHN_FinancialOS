-- The app-level email may follow the login's email, and only that.
--
-- Migration 0028 froze `users.email` outright: "it is the identity the login was
-- created with". The reasoning was right — an email that drifts from the login
-- is how a role ends up attached to the wrong person — but it left no way to
-- perform a legitimate rename. AHN moved its owner account from a personal
-- Gmail address to the company mailbox: the change was made in Supabase Auth,
-- and the `users` row was then stuck showing an address nobody uses, on the
-- Access page where staff check who has which role.
--
-- So the invariant is kept and stated more precisely: `users.email` must equal
-- the email of the auth account named by `auth_id`. A rename is done at the
-- login first, then mirrored here; anything else is still refused.

create or replace function guard_user_role_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  actor uuid := current_app_user_id();
  remaining_owners int;
  login_email text;
begin
  -- Which login a role belongs to is never editable.
  if new.auth_id is distinct from old.auth_id then
    raise exception 'auth_id cannot be changed: it decides which login this role belongs to';
  end if;

  if new.email is distinct from old.email then
    if new.auth_id is null then
      raise exception 'email cannot be changed before this row is linked to a login';
    end if;
    select email into login_email from auth.users where id = new.auth_id;
    if login_email is null or lower(login_email) is distinct from lower(new.email) then
      raise exception
        'email must match the login it belongs to (currently %). Change the address in Supabase Auth first.',
        coalesce(login_email, 'unknown');
    end if;
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
