-- ============================================================================
-- Receivables and payables - Spec sections 17 and 18
--
-- ONE TABLE, TWO DIRECTIONS. Section 17 wants money owed TO AHN; section 18
-- wants money AHN owes. They are the same shape: an amount, a counterparty, a
-- due date, a status, and eventually the transaction that settled it. Aging
-- applies to both — an overdue bill matters as much as an overdue invoice —
-- and two tables would mean two copies of the aging arithmetic.
--
-- These rows are NOT transactions. A transaction is money that moved; an
-- obligation is money that is going to. Keeping them apart is what stops a
-- commitment being counted as cash before it leaves the bank, which is the
-- entire point of section 18.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'obligation_status') then
    create type obligation_status as enum (
      'draft',      -- known about, not yet issued or committed
      'open',       -- issued and outstanding
      'settled',    -- paid, and ideally linked to the transaction that paid it
      'void'        -- cancelled or written off; kept, never deleted
    );
  end if;
end $$;

create table if not exists obligations (
  id              uuid primary key default gen_random_uuid(),

  -- 'inflow'  = a receivable, money owed to AHN (section 17)
  -- 'outflow' = a payable or commitment, money AHN owes (section 18)
  direction       txn_direction not null,

  counterparty_id uuid references counterparties(id) on delete set null,
  -- Kept as text as well: a commitment can exist before the counterparty does,
  -- and a venue deposit for an event AHN has not booked yet still has a name.
  counterparty_name text,

  project_id      uuid references projects(id) on delete set null,
  category        text,

  reference       text,
  description     text,

  amount_minor    bigint not null check (amount_minor > 0),
  currency        char(3) not null default 'USD',

  -- Section 17 asks for contracted AND invoiced. `amount_minor` is what is
  -- currently owed; `contracted_amount_minor` is what was agreed, when the two
  -- differ because only part has been invoiced.
  contracted_amount_minor bigint check (contracted_amount_minor >= 0),

  issued_on       date,
  due_on          date not null,

  status          obligation_status not null default 'open',

  -- The transaction that settled it. Nullable because most obligations are
  -- open, and set on ON DELETE SET NULL because deleting a transaction must not
  -- delete the record that it was owed.
  settled_txn_id  uuid references transactions(id) on delete set null,
  settled_on      date,

  -- Section 18 lists recurring commitments (payroll, retainers, taxes). A
  -- recurring obligation is generated rather than typed in every month.
  is_recurring    boolean not null default false,

  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- A settled obligation must say when. Without this, "paid" rows drift out of
  -- every aging bucket and the totals stop reconciling.
  constraint obligations_settled_has_date check (
    (status = 'settled' and settled_on is not null)
    or (status <> 'settled' and settled_on is null)
  )
);

create index if not exists idx_obligations_due    on obligations(status, due_on);
create index if not exists idx_obligations_dir    on obligations(direction, status, due_on);
create index if not exists idx_obligations_party  on obligations(counterparty_id);
create index if not exists idx_obligations_project on obligations(project_id);

-- --- RLS --------------------------------------------------------------------
alter table obligations enable row level security;

-- An obligation carries a counterparty and an amount, not compensation, so a
-- viewer may read one — with the same payroll exception the ledger uses: a
-- payroll commitment is still payroll.
drop policy if exists p_obligations_read on obligations;
create policy p_obligations_read on obligations for select using (
  is_owner() or (is_app_user() and not is_sensitive_category(category))
);

drop policy if exists p_obligations_write on obligations;
create policy p_obligations_write on obligations for all using (is_owner()) with check (is_owner());
