-- Every provider error, kept — so it can be handed to the provider's support.
--
-- Before this, the only record of a failed sync was `integrations.last_error`:
-- one text column, overwritten by the next failure and cleared by the next
-- success. "Why did QuickBooks stop syncing on Tuesday night?" had no answer by
-- Wednesday morning, and Intuit's support team — who look requests up by the
-- `intuit_tid` header on every response — had nothing to look up.
--
-- One row per failure. What goes in is what support needs and nothing more:
-- when, which operation, how Intuit classified it, their fault code and
-- transaction id, and the message. Never a token, never a request body, never
-- financial data — the insert path redacts anything shaped like a credential.

create table if not exists integration_errors (
  id              uuid primary key default gen_random_uuid(),
  integration_id  uuid references integrations(id) on delete set null,
  provider        text not null,
  occurred_at     timestamptz not null default now(),
  -- 'sync', 'connect', 'disconnect' — what this application was trying to do.
  operation       text not null,
  -- transient / reconnect / configuration / unavailable / rejected, or null
  -- when the failure did not come from a classified provider response.
  kind            text,
  http_status     integer,
  -- Intuit's own code from Fault.Error[0].code: 4000, 4001, 5030…
  fault_code      text,
  -- Intuit's `intuit_tid` response header: the id their support finds a
  -- request by.
  intuit_tid      text,
  message         text not null
);

create index if not exists idx_integration_errors_recent
  on integration_errors (provider, occurred_at desc);

alter table integration_errors enable row level security;

-- Read by whoever manages integrations — the same people who can already see
-- `integrations.last_error`.
drop policy if exists p_integration_errors_read on integration_errors;
create policy p_integration_errors_read on integration_errors
  for select using (can_manage_integrations());

-- Written by the same people, for the one failure that happens in their own
-- request rather than in the scheduler: a disconnect whose revoke Intuit
-- refused. The scheduler and the OAuth callback write with the service role.
drop policy if exists p_integration_errors_insert on integration_errors;
create policy p_integration_errors_insert on integration_errors
  for insert with check (can_manage_integrations());

-- No update and no delete policy, on purpose. A troubleshooting log somebody
-- can edit is not evidence of anything.
