-- ============================================================================
-- Paying people - Spec section 7 (US, Vietnam and Philippines payroll)
--
-- THIS IS THE FIRST FEATURE IN THE SYSTEM THAT MOVES REAL MONEY. Everything
-- before it reads. The security model, the service-role usage and the audit
-- trail were all designed on the assumption that nothing here could cause a
-- payment, and that assumption ends at this table.
--
-- Two facts shaped the design, both established by probing Veem rather than
-- reading about it:
--
--   1. **There is no sandbox.** `sandbox-api.veem.com` serves an HTML sign-in
--      page on every path. The first real send is against production money.
--   2. **A 401 from `api.veem.com` does not prove an endpoint exists.** The
--      gateway authenticates before routing, so a deliberately fake path
--      answers 401 too. The send contract comes from documentation, not from
--      observation, and is therefore unproven until AHN runs it once.
--
-- So the design assumes it cannot be rehearsed:
--
--   - A run is PREPARED, then APPROVED BY SOMEBODY ELSE, then sent. Money never
--     leaves on one person's click.
--   - Every payment carries an idempotency key generated and STORED BEFORE the
--     call. Veem rejects a reused `X-Request-Id` with 409, so a retry after a
--     timeout cannot pay twice - but only if the key survives the crash, which
--     means it has to be in the database first.
--   - A payment row records what was SENT, separately from what Veem later
--     says happened. "We asked" and "it went" are different facts.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'payroll_run_status') then
    create type payroll_run_status as enum (
      'draft',      -- being assembled, nothing committed
      'approved',   -- a second person signed it off; may be sent
      'sending',    -- in flight; no second send may start
      'sent',       -- every line reached a terminal state
      'cancelled'   -- abandoned before sending; kept, never deleted
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'payroll_payment_status') then
    create type payroll_payment_status as enum (
      'pending',    -- prepared, not yet sent
      'sent',       -- Veem accepted it
      'failed',     -- Veem refused it; `error` says why
      'skipped'     -- deliberately excluded from the run
    );
  end if;
end $$;

create table if not exists payroll_runs (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  -- The period being paid for, not the date it is sent.
  period_start  date not null,
  period_end    date not null,
  status        payroll_run_status not null default 'draft',
  currency      char(3) not null default 'USD',

  -- What the run was worth when it was APPROVED. Frozen, so a line changed
  -- afterwards cannot quietly enlarge an approved total.
  approved_total_minor bigint check (approved_total_minor >= 0),

  created_by    uuid references users(id) on delete set null,
  approved_by   uuid references users(id) on delete set null,
  approved_at   timestamptz,
  sent_at       timestamptz,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint payroll_period_ordered check (period_end >= period_start),

  -- An approved run must say who approved it and when. Without this, "approved"
  -- is a word rather than a record.
  constraint payroll_approved_has_approver check (
    (status in ('draft', 'cancelled') and approved_by is null and approved_at is null)
    or (status in ('approved', 'sending', 'sent') and approved_by is not null and approved_at is not null)
  )
);

create table if not exists payroll_payments (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references payroll_runs(id) on delete cascade,
  person_id     uuid references people(id) on delete set null,

  -- Copied from `people` at preparation time, not joined at send time. Somebody
  -- renamed or given a new email between approval and sending must not change
  -- where approved money goes.
  payee_name    text not null,
  payee_email   text not null,
  payee_country char(2) not null,

  amount_minor  bigint not null check (amount_minor > 0),
  currency      char(3) not null default 'USD',
  purpose       text not null default 'Payroll',

  status        payroll_payment_status not null default 'pending',

  /**
   * The idempotency key, generated and stored BEFORE the call.
   *
   * Veem answers a reused `X-Request-Id` with 409. That only protects AHN if
   * the key outlives a crash mid-send, which is why it is written here first
   * and never regenerated on retry.
   */
  request_id    uuid not null default gen_random_uuid(),

  -- What Veem said, kept apart from what we sent.
  veem_payment_id text,
  veem_status     text,
  error           text,
  sent_at         timestamptz,

  created_at    timestamptz not null default now(),

  -- One line per person per run.
  unique (run_id, person_id),
  -- And one idempotency key in the whole table, ever.
  unique (request_id)
);

create index if not exists idx_payroll_payments_run on payroll_payments(run_id, status);
create index if not exists idx_payroll_runs_status on payroll_runs(status, period_end desc);

-- --- The rule that makes approval mean something ----------------------------
/**
 * Nobody approves their own payroll run.
 *
 * The same reasoning as migration 0028's self-role guard: an approval somebody
 * can give themselves is not an approval, it is a formality. Enforced here so
 * it holds regardless of which route asked.
 */
create or replace function guard_payroll_approval() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status = 'approved' and old.status = 'draft' then
    if new.approved_by is not null and new.approved_by = old.created_by then
      raise exception
        'A payroll run must be approved by somebody other than the person who prepared it.';
    end if;
  end if;

  -- An approved run is frozen. Changing the period or the currency after
  -- sign-off changes what was signed off.
  if old.status in ('approved', 'sending', 'sent')
     and (new.period_start is distinct from old.period_start
          or new.period_end is distinct from old.period_end
          or new.currency is distinct from old.currency) then
    raise exception 'An approved payroll run cannot have its period or currency changed.';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_guard_payroll_approval on payroll_runs;
create trigger trg_guard_payroll_approval
  before update on payroll_runs
  for each row execute function guard_payroll_approval();

-- --- RLS --------------------------------------------------------------------
alter table payroll_runs     enable row level security;
alter table payroll_payments enable row level security;

-- Payroll IS compensation. Same audience as the `people` rates.
drop policy if exists p_payroll_runs_read on payroll_runs;
create policy p_payroll_runs_read on payroll_runs for select using (can_see_compensation());
drop policy if exists p_payroll_payments_read on payroll_payments;
create policy p_payroll_payments_read on payroll_payments for select using (can_see_compensation());

-- Writing is narrower still: only a role that may move money.
drop policy if exists p_payroll_runs_write on payroll_runs;
create policy p_payroll_runs_write on payroll_runs for all
  using (can_move_money()) with check (can_move_money());
drop policy if exists p_payroll_payments_write on payroll_payments;
create policy p_payroll_payments_write on payroll_payments for all
  using (can_move_money()) with check (can_move_money());

comment on table payroll_runs is
  'Spec 7. The first table in this system that causes money to leave. Prepared, approved by a second person, then sent.';
