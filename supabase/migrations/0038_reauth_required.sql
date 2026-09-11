-- A connection that is broken in a way only the customer can fix.
--
-- `integration_status` had three values: disconnected, connected, error. That
-- collapses two situations which call for opposite responses:
--
--   error            something went wrong; the next sync will try again.
--   reauth_required  the grant is gone. No number of retries will help, and
--                    nothing changes until a person authorises again.
--
-- With only `error` available, a revoked QuickBooks token produced a sync that
-- failed every ten minutes forever, looking exactly like a provider having a
-- bad afternoon. Nobody was ever told to reconnect, because nothing in the
-- system could tell that reconnecting was the answer.
--
-- Intuit asks specifically about this: whether the app retries failures, and
-- whether it asks the customer to reconnect when authorisation fails. Those are
-- two different answers to two different failures, and this is the column that
-- can finally hold the difference.

do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'integration_status' and e.enumlabel = 'reauth_required'
  ) then
    alter type integration_status add value 'reauth_required';
  end if;
end
$$;
