-- ============================================================================
-- Projects, events and the hierarchy above them - Spec sections 12, 14, 15, 16
--
-- AN EVENT IS A PROJECT. Spec section 14 opens with "treat each event as its
-- own project", and it is right: the P&L arithmetic is identical, only the
-- category names differ. Two tables would mean two implementations of one
-- calculation, and the second one would drift.
--
-- The hierarchy in section 15 is Company > Business Unit > Service > Client >
-- Project. Business units and services are rows, not enums, because section 15
-- requires them to be "editable/admin-configurable" - an enum would need a
-- migration every time AHN adds a service line.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'project_kind') then
    create type project_kind as enum ('project', 'event');
  end if;
  if not exists (select 1 from pg_type where typname = 'project_status') then
    create type project_status as enum ('planned', 'active', 'completed', 'cancelled');
  end if;
end $$;

-- --- Business units (spec 15) -----------------------------------------------
create table if not exists business_units (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  -- Free text rather than a foreign key to itself: AHN Labs has a dozen
  -- categories (e-commerce, sourcing, TikTok Shop, CAP...) and section 15 wants
  -- them editable, not modelled.
  services   text[] not null default '{}',
  is_active  boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

-- --- Clients (spec 15) ------------------------------------------------------
-- Separate from `counterparties`. A counterparty is whoever appears on a bank
-- line, which includes every vendor, bank and refund. A client is who the work
-- is for. They overlap but they are not the same list, and conflating them
-- would put Slack and the electricity company in the client dropdown.
create table if not exists clients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  normalized_name text not null unique,
  counterparty_id uuid references counterparties(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now()
);

-- --- Projects and events ----------------------------------------------------
create table if not exists projects (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid references companies(id) on delete set null,
  business_unit_id uuid references business_units(id) on delete set null,
  client_id        uuid references clients(id) on delete set null,
  name             text not null,
  code             text unique,
  kind             project_kind not null default 'project',
  service          text,
  status           project_status not null default 'active',
  starts_on        date,
  ends_on          date,

  -- HUMAN-SUPPLIED, and deliberately nullable. Spec 12 asks for contracted and
  -- invoiced revenue; neither exists anywhere in a bank feed. Cash received and
  -- direct expenses come from the ledger. Leaving these null is honest - a zero
  -- would read as "nothing contracted" rather than "nobody has told us".
  contracted_revenue_minor bigint check (contracted_revenue_minor >= 0),
  invoiced_revenue_minor   bigint check (invoiced_revenue_minor >= 0),
  budget_expense_minor     bigint check (budget_expense_minor >= 0),
  currency         char(3) not null default 'USD',

  owner_user_id    uuid references users(id) on delete set null,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_projects_unit   on projects(business_unit_id);
create index if not exists idx_projects_client on projects(client_id);
create index if not exists idx_projects_kind   on projects(kind, status);

-- --- The link that makes any of it computable -------------------------------
alter table transactions
  add column if not exists project_id uuid references projects(id) on delete set null;

-- Every project P&L query filters on this, and the unassigned queue asks for
-- the rows where it is null.
create index if not exists idx_txn_project on transactions(project_id, txn_date desc);
create index if not exists idx_txn_unassigned on transactions(txn_date desc) where project_id is null;

comment on column transactions.project_id is
  'Which project or event this line belongs to. Null means unassigned, which is the normal state for overheads - spec 16 distinguishes direct costs from allocated ones, and only direct costs are attributed here.';

-- --- RLS --------------------------------------------------------------------
alter table business_units enable row level security;
alter table clients        enable row level security;
alter table projects       enable row level security;

drop policy if exists p_units_read on business_units;
create policy p_units_read on business_units for select using (is_app_user());
drop policy if exists p_units_write on business_units;
create policy p_units_write on business_units for all using (is_owner()) with check (is_owner());

drop policy if exists p_clients_read on clients;
create policy p_clients_read on clients for select using (is_app_user());
drop policy if exists p_clients_write on clients;
create policy p_clients_write on clients for all using (is_owner()) with check (is_owner());

-- A project row carries contracted values and margins. Viewers may read them;
-- only the owner may change them, same as every other financial control here.
drop policy if exists p_projects_read on projects;
create policy p_projects_read on projects for select using (is_app_user());
drop policy if exists p_projects_write on projects;
create policy p_projects_write on projects for all using (is_owner()) with check (is_owner());
