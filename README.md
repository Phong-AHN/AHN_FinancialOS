# AHN Financial OS

**Every dollar in. Every dollar out.**

Cash visibility and every-dollar alerting for Asian Hustle Network — the week-1 MVP
described in [AHNFinancialOSMVPPlan.md](AHNFinancialOSMVPPlan.md), built against the
full spec in [requirement.txt](requirement.txt).

QuickBooks stays the ledger. This is the operational intelligence layer above it:
where the money is, where it went, how long it lasts, and what needs attention now.

---

## What is built

Every item in the plan's **Definition of Done** (§2):

| Definition of Done | Where it lives |
|---|---|
| Total cash by account/entity, rolling up to one correct number | [engine.ts `computeCashPosition`](src/lib/calc/engine.ts) → [/accounts](src/app/(app)/accounts/page.tsx) |
| Slack + email alert within minutes of any new transaction | [alerts/engine.ts](src/lib/alerts/engine.ts), [channels.ts](src/lib/alerts/channels.ts) |
| Runway + burn from a deterministic formula, not an AI guess | [`computeBurnRate`, `computeRunway`](src/lib/calc/engine.ts) |
| This month's break-even revenue on the home screen | [`computeBreakEven`](src/lib/calc/engine.ts) → [CEO home](src/app/(app)/page.tsx) |
| Click any dashboard number → the transactions behind it | Every tile links into [/transactions](src/app/(app)/transactions/page.tsx) with URL filters |
| Audit entry on every hand edit (old, new, who, when) | [audit.ts](src/lib/audit.ts) → [/audit](src/app/(app)/audit/page.tsx) |
| QuickBooks ↔ Plaid matches flagged, not double-counted | [dedup.ts](src/lib/dedup.ts) → [/reconcile](src/app/(app)/reconcile/page.tsx) |

Plus the rest of the 7-day schedule: Supabase schema and auth (Day 1), QuickBooks
OAuth + sync (Day 2), Plaid + Stripe + dedup (Day 3), the alert engine across
Slack/email/SMS (Day 4), the calc engine and CEO home (Day 5), drill-down, the
reconcile queues and CSV import (Day 6), roles and RLS (Day 7).

---

## Quick start

```bash
npm install
cp .env.example .env.local
```

Fill in four values to boot:

```bash
NEXT_PUBLIC_SUPABASE_URL=...        # Supabase → Settings → API
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...       # server-only, never shipped to the browser
SUPABASE_DB_URL=...                 # Settings → Database → Connection string → Session pooler

# 32-byte key that encrypts OAuth tokens at rest
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
```

Then:

```bash
npm run db:seed     # 11 tables + RLS + default alert rules + ~7 months of demo money
npm run dev
```

`db:seed` prints the SQL for your owner row. Run it, invite the same address through
Supabase Auth (Authentication → Users), and sign in.

Use `npm run db:push` instead if you want the schema without demo data.

### Connecting real money

Integrations are optional to boot and can be added one at a time on
`/integrations`. None of them block the dashboard — CSV import alone will populate it.

| | Env vars | Notes |
|---|---|---|
| QuickBooks | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI` | Production keys are issued immediately for an internal app |
| Plaid | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Development env connects up to 100 real accounts |
| Stripe | `STRIPE_SECRET_KEY` | Read-only usage |
| Slack | `SLACK_BOT_TOKEN` + `SLACK_DEFAULT_CHANNEL`, or `SLACK_WEBHOOK_URL` | Optional per-severity routing via `SLACK_CHANNEL_CRITICAL` / `_WARNING` / `_DIGEST` |
| Email | `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` | |
| SMS | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ALERT_SMS_TO` | Warning/critical only |
| Cron | `CRON_SECRET` | Required, or `/api/cron/*` refuses to run |

> **Use the Session pooler URI, not the direct one.** Supabase's direct host,
> `db.<ref>.supabase.co`, publishes only an AAAA record — on an IPv4-only network
> it is unreachable and the error (`ENOTFOUND`/`ENETUNREACH`) says nothing about
> why. The pooler is reachable over IPv4 and takes the same password with the
> user rewritten to `postgres.<ref>`.
>
> `npm run db:push` handles this itself: given a direct URL it cannot reach, it
> probes the pooler regions, runs the migrations through the one that answers,
> and prints the URL to save. Only `db:push` needs this — the app and
> `npm run db:seed` talk to Supabase over HTTPS and are unaffected.

> **Environment variables are read once, at process start.** Editing `.env.local`
> while the app is running changes nothing — the Integrations page will keep
> reporting credentials as missing even though the file is correct. Restart the
> server after any change.
>
> For QuickBooks specifically, `QBO_ENVIRONMENT` accepts only `sandbox` or
> `production`. `development` is a Plaid value; using it here points sandbox
> keys at the live API and fails with an opaque 401 during OAuth. The key pair
> and the environment must match, and `QBO_REDIRECT_URI` must be registered on
> the Intuit app under that same environment.

An unconfigured channel is recorded as **skipped** on the notification row rather
than failing silently — the Alerts page shows exactly which ones are dark.

---

## Architecture

```
QBO · Plaid · Stripe · CSV (VN bank / VEEM / payroll)
        │        connectors/  — one file per source, nothing else knows they differ
        ▼
   ingest.ts   — counterparty resolution → categorisation → USD stamping → dedup
        │
        ▼
  Postgres (Supabase)  — 11 tables, RLS on every one
        │
        ▼
 calc/engine.ts — pure functions: cash · burn · runway · break-even
        │
        ├──▶ alerts/engine.ts → Slack · email · SMS · in-app
        └──▶ app/ — CEO home, drill-down, reconcile, audit
```

**Every source writes through one path.** That is what makes the plan's promise
real: when VEEM or a Vietnamese bank eventually grants API access, a new file lands
in `src/lib/connectors/` and nothing downstream changes.

**The calc engine is pure.** No network, no database, no model — plain functions over
plain rows. Spec §20 draws a hard line between deterministic math and AI
interpretation, and this is that line, enforced by the module boundary.

### The money rules

Three invariants run through the whole codebase:

1. **Integers only.** Every amount is an integer count of the currency's minor unit
   (USD cents, VND đồng). No float ever holds a balance. `19.99 * 100` is
   `1998.9999999999998` in IEEE-754, and a cent lost per subscription line ends up in
   the runway number.
2. **`amount_minor` is always positive; `direction` carries the sign.** Summing a mixed
   set uses the generated `signed_minor` column.
3. **Two different filters, never mixed up:**
   - `countsTowardCash` — excludes duplicates, *keeps* internal transfers (moving money
     between our own accounts really does change each account's balance)
   - `countsTowardPnl` — excludes duplicates *and* internal transfers (moving your own
     money is neither revenue nor expense)

### The formulas, stated openly

Every one is visible in the UI next to the number it produces.

| | |
|---|---|
| **Account balance** | provider-reported balance where one exists, else `opening_balance + Σ signed non-duplicate transactions`. The variance between the two is shown, not hidden. |
| **Burn** | average operating outflow over the last *N* **complete** calendar months (default 3). The current partial month is excluded — on the 3rd it holds three days of spend, and averaging it in would understate burn and flatter runway. |
| **Runway** | Three figures, never one. `grossMonths` = cash ÷ gross burn (if revenue stopped); `netMonths` = cash ÷ net burn (null while cash-positive); `worstCaseMonths` = cash ÷ the worst single month observed. The screen headlines the **net** figure while burning and the **gross** figure while cash-positive — printing ∞ to a company spending six figures a month is the most flattering possible way to be wrong. |
| **Break-even revenue** | `spend booked this month + (trailing-90-day average daily outflow × days remaining)`. Self-correcting: as real spend lands, the projected share shrinks and the figure converges on actuals. |
| **Net profit MTD** | cash basis — money received less money spent. |

---

## Testing

```bash
npm test          # unit + integration suites
npm run typecheck
npm run build
npm run smoke -- you@example.com 'password'   # loads every page as a signed-in owner
```

`npm run smoke` covers the one gap the rest cannot: the tests call the calc engine
directly, so a page that throws while *rendering* those numbers passes all of them,
and `next build` misses it too because every page here is server-rendered on demand.
Pass a base URL as a third argument to check a deployment.

Two integration suites read the live database and skip themselves without Supabase
credentials, so a fresh clone still runs green. One further suite delivers real Slack
and email messages and is gated behind `ALERT_E2E=1`.

The tests cover what breaks quietly: float rounding, VN decimal separators,
month-boundary arithmetic (`2026-01-31` minus one month is *not* March 3rd),
duplicate exclusion from cash, transfer exclusion from burn, alert-channel merging,
and unreadable CSV rows landing in the error bucket rather than importing as zero.

---

## Security

- OAuth for QuickBooks and Plaid; bank credentials are entered inside Plaid's own
  iframe and never touch this application (spec §25).
- Access/refresh tokens are AES-256-GCM encrypted before reaching the database
  ([crypto.ts](src/lib/crypto.ts)). A leaked database dump is not a leaked bank connection.
- Row Level Security on all 11 tables. Viewers cannot read payroll rows or integration
  credentials — enforced by policy, not by the interface.
- `audit_logs` has an insert policy and no update or delete policy for any role, so a
  financial edit trail cannot be rewritten after the fact.
- `/api/cron/*` requires a bearer `CRON_SECRET` and refuses to run without one, rather
  than defaulting to open.
- Secrets live only in environment variables; `.env*` is gitignored.

---

## Deliberate deviations from the plan

Three, each documented in full in [docs/DECISIONS.md](docs/DECISIONS.md):

1. **11 tables, not 10** — `exchange_rates` was added. AHN holds USD and VND accounts,
   and "one correct total cash number" cannot be produced without a dated rate.
   Spec §27 lists it as a core entity.
2. **QuickBooks Invoices and Bills are not synced into `transactions`** — they are
   accruals. An invoice and the payment that settles it are the same dollar, and
   booking both would break the non-negotiable "no transaction is double-counted"
   criterion. They belong to the AR/AP module (spec §17–18, Phase 2).
3. **Suspected duplicates are held *out* of cash, and the withheld amount is shown**
   — the plan calls for flagging rather than double-counting. Excluding is the safe
   direction; displaying the excluded total keeps it honest.

---

## Not in week 1

Per the plan's §8, and unchanged: subscription intelligence, project and event P&L,
time tracking, the revenue/margin simulator, budget vs. actual, the full AI CFO
layer, the complete 7-role RBAC, and real APIs for VN banks / VEEM / payroll.

The schema is shaped so these attach without a rebuild — `is_subscription` and
`is_recurring` are already populated on every transaction, categories already follow
the spec §7 taxonomy, and counterparties are already normalised and deduplicated.
