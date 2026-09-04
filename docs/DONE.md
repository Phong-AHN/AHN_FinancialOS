# What is built

Status as of 3 Sep 2026. For a one-page version see [CHECKLIST.md](CHECKLIST.md). The counterpart to [TODO.md](TODO.md), which lists
what is *not* done and who it is waiting on.

**Week 1 (Days 1–7) is complete. Every Phase 2 feature is built and Phase 3 is
under way.** The one Phase 2 item still open is real API access for the VN banks and
VEEM — the connectors are written and tested; what is missing is AHN’s registration,
not code.

At a glance: 17 nav pages (19 routes) · 35 API routes · 35 migrations · 575 passing tests
(72 gated behind env flags) · 101 recorded engineering decisions.

---

## Week 1 — the MVP plan

- [x] **Day 1 — Foundations.** Supabase project, Next.js 14 + TypeScript strict
      (`noUncheckedIndexedAccess`), 11-table schema, money as integer minor
      units throughout. No float ever holds a balance.
- [x] **Day 2 — Ingestion.** QuickBooks OAuth2, Plaid `/transactions/sync`,
      Stripe `balance_transactions`, CSV import with column mapping. All four
      land in one `transactions` table with one shape.
- [x] **Day 3 — The deterministic engine.** Cash, burn, runway, break-even as
      pure functions. Two filters that are never mixed: `countsTowardCash`
      (excludes duplicates, keeps internal transfers) and `countsTowardPnl`
      (excludes both).
- [x] **Day 4 — Alerting.** Rules engine, Slack + email + SMS + in-app, one
      alert per transaction carrying the highest severity and the union of
      channels. Delivery log records every attempt with its result.
- [x] **Day 5 — CEO home screen.** Answers all seven questions in spec §21,
      with an integration test that asks them one at a time against live data.
- [x] **Day 6 — Drill-down and reconciliation.** Every figure links to the
      transactions behind it. Cross-source duplicate detection, category
      re-run, opening-balance reconciliation.
- [x] **Day 7 — Roles and audit.** Owner/viewer with Row Level Security as the
      real boundary, immutable audit trail on every hand edit.

## Phase 2 — since then

- [x] **Subscription intelligence (§8).** `/subscriptions` finds recurring
      charges from the payments themselves, never from a flag: same vendor,
      three or more times, even gaps, **and amounts sitting on one or two
      repeated prices**. Live: 11 charges at $8,049/mo.
- [x] **Price-increase alerts (§8).** Fires once per vendor per price change —
      deduped by event, not by a daily cooldown that would re-announce the same
      rise forever. Clears both floors or stays quiet: ≥10% *and* ≥$50/year.
- [x] **Project & event P&L (§12, §14, §15).** An event is a project with
      `kind='event'`, because the arithmetic is identical and two tables would
      mean two implementations that drift. Business units and services are
      editable rows, seeded with the five units and twelve AHN Labs services
      the spec names.
- [x] **Profitability roll-up (§16).** By business unit, service, client, kind
      or status — summing the individual P&Ls rather than recomputing, so the
      two can never disagree.
- [x] **Time tracking & labour cost (§13).** All three costing bases: salaried,
      hourly, contractor rate. Projects now show **net** profit after the people
      who did the work, with hours and cost variance against estimate and
      budget.
- [x] **Growth & margin simulator (§11).** What a growth rate compounds to, and
      what revenue a margin target would require. Scenarios derived from AHN's
      own month-over-month history, not from invented round numbers.

- [x] **Budget vs. actual (§19).** Budgets at six levels over month, quarter or
      year, with variance and a projected final cost that states how much to
      trust it - below a quarter of the way through a period it says "too early
      to say" instead of printing a run rate built on almost no evidence.
      Overspend alerts fire *before* the overspend, once per budget per period.

- [x] **Receivables and payables (§17, §18).** One table, two directions, with
      aging buckets and the figure the feature exists for: cash after
      commitments. Receivables are excluded from it on purpose. Detects
      obligations a payment has already settled, so committed cash is not
      charged twice for one bill.

## Vietnam banking groundwork

- [x] **VEEM connector (§2, §18).** Client-credentials OAuth against
      `api.veem.com`, the host proved to answer. Only a payment VEEM reports as
      **Complete** counts as cash; anything in flight becomes a commitment on
      *Owed & owing* and is settled automatically when it completes, so no
      dollar is counted twice. Replaces the CSV export as the live route —
      `csv_veem` stays, because a file exported last quarter is still a real
      record of what happened.

- [x] **VN bank statement import proven end to end.** The template in
      `samples/` imports with every amount matching the statement to the dong,
      Vietnamese descriptions categorised (`CHUYEN LUONG` → payroll,
      `PHI DICH VU NGAN HANG` → bank fees), and VND converted to USD for the
      rollup. Two real bugs found doing it — decisions 61 and 62.
- [x] **Exchange rates editable in the app**, dated and audited, entered the way
      Vietnam quotes them (dong to the dollar) with the inverted-entry mistake
      rejected outright.
- [x] **Bank API availability established.** VietinBank has a self-serve
      sandbox; Techcombank does not. Neither is reachable today without an
      application, so the route taken is an aggregator.
- [x] **VietinBank iConnect connector written** against the bank's own OpenAPI
      document: `POST /inquiry` on the corporate ERP Statement API, apiKey
      headers rather than OAuth2, debit/credit columns, two different date
      formats, and a status code that lives inside a 200 response. Wired into
      the sync scheduler with a Connect button that proves the credentials
      before storing anything. 21 tests, including the bank's own documented
      example response. Finverse covers **individual accounts only** for both
      Vietnamese banks, which makes this the primary route — decisions 67-69.
- [x] **Finverse connector written** — auth, Link flow, callback, account and
      transaction sync, wired into the sync orchestrator and `/integrations`.
      Written against the vendor's published TypeScript SDK, so every path and
      field traces to a line in their repository rather than to a guess.
      **Its HTTP calls have not run yet** — there are no credentials. The pure
      half is covered by 22 tests, four of them against Finverse's own example
      payloads.

## Phase 3

- [x] **The backlog is empty.** The last three items each needed a decision,
      and each was made explicitly: software allocated **by share of logged
      hours** (never an even split, and nothing at all when no hours exist);
      saved scenarios storing **inputs and the baseline, never the figures**;
      and department budgets where a **department owns §7 categories** rather
      than demanding every transaction be tagged a second time.

- [x] **The deployment guide is complete, and checked.** It listed 17 variables
      where the app reads 49 — `STRIPE_SECRET_KEY` absent while Stripe was
      syncing, `SLACK_SIGNING_SECRET` absent so slash commands would refuse.
      Rewritten in four groups with the consequence beside each variable, and a
      test that runs on every `npm test` keeps it honest.

- [x] **The types are checked against the live schema.** Hand-written types
      drift; two had, silently, across four migrations. A test now compares
      twelve of them to PostgREST's own description of the database, in both
      directions, parsing the real source rather than restating it. Found a
      third: `AppUser` could not see `slack_user_id`.

- [x] **Alerts never fire on money that is not real.** A sandbox integration's
      rows are skipped by the transaction and obligation alert paths — counted,
      not silently dropped — and the suppression lifts itself the day the
      environment goes to production. Stops 31 fake QuickBooks invoices paging
      the CEO.

- [x] **Money-critical reads can no longer fabricate a zero.** A query error
      used to render as an empty table and therefore as `$0.00`. Found a fourth
      live instance while fixing it: the exchange-rate feed queried a table that
      does not exist and had only ever priced VND. Eight reads now fail loudly;
      the rule is narrow — if an empty result would be shown as a financial
      figure, the read must not be able to invent one.

- [x] **The plan's acceptance checklist runs against live data.** Plan §10 /
      spec §28's twelve criteria, as executable assertions: **10 hold, 2 built
      with no data, 0 fail.** "Built" and "proven on AHN's data" are reported
      separately — they call for opposite responses.

- [x] **Budgets are editable in place — and the key that was supposed to make
      that possible was broken.** `scope_id` is NULL for a category budget, and
      Postgres treats NULLs as distinct, so the unique key never matched itself:
      every save created another budget and the live database held six
      duplicates. `NULLS NOT DISTINCT` fixed it; the amount is now editable on
      the row, with a closed period left read-only.

- [x] **Gross *or* net margin targets (§11).** The simulator now asks which
      basis a margin means — all operating spend, or cost of delivery only. The
      same 40% target implies four times the revenue on one basis as the other.
      Refuses rather than measuring against a delivery cost of zero.

- [x] **Recurring commitments generate themselves (§18).** Payroll, retainers,
      rent and taxes carry a cadence — monthly, quarterly or annual — and the
      daily job fills ninety days ahead. Idempotent by calculation and by a
      unique index, so a job that runs every day cannot create thirty copies of
      March's rent. Next month's payroll is now visible before it is entered,
      which is what §18 asks for.

- [x] **Labour reaches the §16 roll-up, and projects can be corrected.** The
      roll-up gains `Labour` and `After labour` columns — gross profit keeps its
      old meaning, so a figure quoted last month does not change value. Absent
      entirely, not zeroed, for a reader who may not see compensation. And
      `PATCH /api/projects/[id]` makes a project editable after creation:
      name, status, dates, contracted and invoiced revenue, budgets — every
      change audited, the business unit deliberately fixed.

- [x] **Linking a login to a person, from the app (§13).** The step self-service
      time tracking still needed a SQL console for. One login is one person,
      enforced by a unique index; the picker greys out one already taken and
      names who holds it. Audited — who may log hours as whom decides whose
      salary a project's margin carries.

- [x] **People log their own hours (§13).** `/timesheet` — the missing half of
      every project margin. An employee may write rows for their own person,
      dated within the last fortnight, enforced by Postgres; a `projects_for_time`
      view gives them project names without contract values, because RLS cannot
      hand back a subset of the columns. Proved with an employee's own token,
      then driven through the real page and route.

- [x] **Profitability by unit, client, service, kind or status (§16).** On
      `/projects`, grouped from the same per-project P&Ls shown above it — never
      recomputed, because two implementations of one sum cannot both be trusted
      when they disagree. The footer shows the groups adding back to the
      portfolio total, and says so when they do not.

- [x] **Assigning access from the app (§23).** `/access` changes a role and
      links a Slack account, with the boundary in Postgres rather than in the
      route: write policies on `users` plus a trigger that refuses
      self-promotion, refuses to lose the last owner, and refuses to re-point a
      row at a different login. Proved from outside with real tokens — nine
      assertions through the anon key, not the service role.

- [x] **Receivables and payables pulled from QuickBooks (§17, §18).** Invoices
      and bills land in `obligations`, never in the ledger — an invoice and the
      payment that settles it are two records of one event. Open items are
      pulled however old they are, because an invoice raised in June is still
      owed in September; recently-changed ones come too, so a paid invoice is
      told it was paid instead of ageing forever. Idempotent on QuickBooks' own
      id. Verified live: 46 in, 21 already settled, second pass inserts nothing.

- [x] **Slack slash commands (§5).** `/ahn cash`, `runway`, `burn`, `breakeven`,
      `spend [7|30|90]` and `unusual`, answered from the same engine the
      dashboard reads. Two gates: Slack's request signature, then an identity
      link — `users.slack_user_id` maps a Slack account to one app user, and
      that user's role decides the answer. Being in the workspace is not
      permission. Every reply is ephemeral, so the per-person check cannot be
      sidestepped by asking in a busy channel.

- [x] **Exchange rates refresh themselves (§3).** Daily from Vietcombank — the
      rate AHN could actually transact at, not a mid-market index — with a
      keyless global feed behind it for anything the bank does not list. The
      dong is valued at the bank’s sell rate, which understates rather than
      flatters. A rate set by hand is never overwritten, an implausible one is
      refused rather than stored, and every rate now shows its own date, its
      source and its age. Verified live across all three outcomes: written,
      unchanged, and deferring to a rate a person set.
- [x] **“Today” is Vietnam, not UTC.** `BUSINESS_TIME_ZONE` decides what day it
      is now; stored dates and all arithmetic over them stay in UTC. Without
      this the dashboard named the wrong day for the seven hours a day the two
      clocks disagree — every day, on a Vercel server — and a figure could land
      in the wrong month at month end. Found by the rate feed filing a rate
      under yesterday.

- [x] **What changed, and why (§20, the deterministic half).** `/explain`
      reconciles the cash move exactly — opening plus money in, less money out,
      equals closing, in whole cents — then names who moved rather than which
      category did, because "Acme paid $40,000 last month and nothing this
      month" is a phone call and "professional services fell" is not. Anomalies
      are judged against each vendor's own median, so payroll no longer trips
      the alarm every month and a $300 charge from a $20 vendor finally does.
      §20 says AI should *interpret* deterministic figures, not compute them;
      this is the half that has to be right before any model reads it.

- [x] **The seven roles (§23).** Owner, CFO, accountant, department lead,
      project manager, employee, viewer — enforced by Postgres, with the matrix
      in one capability function each rather than role names spread across 28
      policies. Scoped roles see their own unit or projects, deliberately less
      than a viewer. Building it found a live hole: `FOR ALL` write policies
      were silently granting full-table reads.

## Security

- [x] **Audited and hardened** — full report in [SECURITY.md](../SECURITY.md).
      Five real issues found by testing the running application: an open
      redirect in the sign-in callback, no CSRF protection on 20 state-changing
      routes, no rate limiting, a length-leaking secret comparison, and no CSP
      or HSTS. All fixed and each fix proven by executing the attack.
- [x] **What was already right, verified rather than assumed**: RLS enforced at
      the database and tested with a real viewer token, an append-only audit
      trail with no UPDATE or DELETE policy, AES-256-GCM at rest for every
      integration token, and all 13 service-role routes gated.

## Infrastructure

- [x] **Railway worker** replacing Vercel Cron — zero dependencies, `node:http`
      only, with a `/health` endpoint that reports runs and failures per job.
- [x] **Region pinned to `hnd1` (Tokyo)**, beside the Supabase project. Vercel
      defaults to Washington DC, which would have made every query cross the
      Pacific twice.
- [x] **Page loads cut 54%** (7.6s → 3.5s across all pages) by removing three
      duplicate auth round trips per click.
- [x] **`npm run smoke`** signs in as a real user and loads all 17 pages —
      the only check that exercises the app the way a person does.

---

## What the system currently holds

| | |
|---|---|
| Transactions | **135** — 66 QuickBooks, 49 Plaid, 20 Stripe |
| Accounts | 20, across 3 connected integrations |
| Alert rules | 8 · **218** notifications delivered and logged |
| Business units | 5, seeded from spec §15 |
| Uncategorised | 26 — **26% of the last 90 days’ spending, $8,173.54**, mostly QuickBooks `BillPayment` rows with no expense account |
| Receivables | 20 open, **$5,281.52** — pulled from QuickBooks, all currently overdue |
| Payables | 5 open, **$1,602.67** |

All of it fetched from the platforms. No demo data — the seed rows were removed
so the connectors could be verified, and every test fixture created since has
been deleted again.

---

## Things worth knowing about how this was built

Three habits did most of the work, and each caught bugs nothing else did:

1. **Read the output, not just the pass.** Reading what the subscription
   detector actually printed found $3,103/mo of internal transfers counted as
   recurring cost. Reading the simulator's rendered scenarios found a
   "conservative case" of −100%. No test failed in either instance.

2. **Prove security at the database, never at the route.** Every permission
   check runs with a real viewer's token through the anon key. Service-role
   queries prove nothing about policies — which is exactly how a payroll leak
   survived a passing test suite once already. And an empty result never
   decides a permission: “there is nothing here” and “you may not see what is
   here” are indistinguishable from the answer, which is the whole point of
   RLS. Getting that backwards cost a real bug — decision 90.

3. **Say what cannot be known.** Null is not zero. An uninvoiced project reads
   "not recorded", a margin on zero revenue is null rather than infinity, and
   allocated software is reported as *absent* from project margins rather than
   as a confident $0 that would flatter every one of them.

The full reasoning, including the mistakes, is in
[DECISIONS.md](DECISIONS.md) — 101 numbered entries.
