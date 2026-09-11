# Done — the short version

One page. [DONE.md](DONE.md) has the detail, [TODO.md](TODO.md) has what is left,
[DECISIONS.md](DECISIONS.md) has the reasoning.

_8 Sep 2026 · 28 pages (20 behind a login, 8 outside it) · 38 API routes · 40 migrations · 711 tests · 110 decisions_

---

## Week 1 — the 7-day plan · **complete**

- [x] **Day 1** Supabase, Next.js, 11-table schema, money as integer minor units
- [x] **Day 2** QuickBooks · Plaid · Stripe · CSV — all into one `transactions` table
- [x] **Day 3** Cash, burn, runway, break-even as pure functions
- [x] **Day 4** Alert rules → Slack, email, SMS, in-app
- [x] **Day 5** CEO home screen — all seven questions in §21
- [x] **Day 6** Drill-down, duplicate detection, reconciliation
- [x] **Day 7** Roles enforced by Postgres, immutable audit trail

## Phase 2 — **every feature built**

- [x] §8 Subscriptions — recurring charges found from payments, price rises alerted
- [x] §12 §14 §15 Project & event P&L — labour **and** allocated software
- [x] §16 Profitability by unit, client, service, kind, status — reconciliation shown
- [x] §13 Time tracking, loaded labour cost, staff log their own hours
- [x] §11 Growth simulator + margin targets, **gross or net**, plans savable
- [x] §19 Budget vs. actual at seven levels including **departments**, editable in place
- [x] §17 §18 Receivables & payables — 46 syncing from QuickBooks, recurring commitments auto-generate

## Phase 3 — **4 of 5 built**

- [x] §23 Seven roles, enforced in Postgres — not in the routes
- [x] §3 VND/USD refreshed daily from Vietcombank
- [x] §5 Slack slash commands (`/ahn cash`, `runway`, `burn`, `spend`, `unusual`)
- [x] §20 The deterministic half — `/explain`: where cash went, who moved, what is unusual
- [ ] §20 The **interpretation** half — waits on 2–3 months of clean data (plan §11)

## Integrations

- [x] QuickBooks · Plaid · Stripe · CSV import
- [x] VietinBank iConnect — written, request shape proved against the bank
- [x] Finverse — the aggregator fallback for Vietnamese banks
- [x] VEEM — API connector; only `Complete` counts as cash, in-flight becomes a commitment
- [x] **Payroll disbursement through VEEM** — two-person approval, ceilings, dry run by default
- [ ] Google Workspace / SaaS vendor billing — needs per-vendor credentials

## Security & operations

- [x] Audited — [SECURITY.md](../SECURITY.md): open redirect, CSRF, rate limiting, CSP, HSTS
- [x] Every permission proved with a real token against the database, never at the route
- [x] Plan §10 / spec §28 acceptance checklist runs against live data — 10 hold, 2 no data, 0 fail
- [x] Money-critical reads fail loudly rather than rendering a query error as $0.00
- [x] Alerts never fire on money that is not real — sandbox sources are skipped
- [x] Hand-written types checked against the live schema, both directions
- [x] Deployment guide lists every variable the app reads — checked on every test run
- [x] Railway worker: sync every 10 min, rates + digest + sweeps daily
- [x] Region pinned beside the database; "today" resolves in Vietnam, not UTC
- [x] Public **privacy policy** and **EULA**, plus Intuit's Launch / Disconnect / Connect URLs
- [x] Disconnect revokes at Intuit **and** deletes the stored token — the policy said so, now it is true
- [x] Transient provider failures retried with jittered backoff; a dead grant is **not** retried
- [x] A revoked connection sets `reauth_required`, prompts a reconnect, and alerts once
- [x] A 401 forces one token refresh and retries — proved against live Intuit, rotation tracked so the retired token is never replayed
- [x] OAuth `state` proved against forged callbacks: missing, empty and mismatched all refused
- [x] No OAuth Playground or offline tokens — every grant comes from the in-app flow, enforced by test
- [x] QuickBooks **CDC** for incremental syncs — 2 calls instead of 9, and deletions finally reach the ledger
- [x] Works on every QuickBooks edition — a feature the subscription lacks is skipped and re-checked daily, never fatal
- [x] Provider error log with Intuit's `intuit_tid` and fault code — kept, redacted, never editable
- [x] Syntax and validation errors are `rejected` and sent once, not retried three times — proved live
- [x] Support reachable from every page, the sign-in page, and every logged error
- [x] **Two-factor sign-in mandatory for every account**, enforced by the database — a password alone reads nothing
- [x] Next.js 14 → 15.5.25: 23 advisories, two critical RCEs, closed — `npm audit` 0
- [x] Weekly vulnerability checks in CI and Dependabot, no secrets needed
- [x] Privacy policy names every service alerts pass through, checked by test

---

## Not done, and why

| | Why |
|---|---|
| §20 interpretation layer | Needs 2–3 months of clean data. Ledger holds 135 sandbox rows. |
| Google Workspace / SaaS billing | Per-vendor credentials |
| — | Nothing else. The engineering backlog is empty. |

## Waiting on you, not on code

- ✅ QuickBooks **approved for production** — follow DEPLOYMENT.md → *Switching QuickBooks from the sandbox to the real company*
- 🔴 Plaid Production · 5 VietinBank values · VEEM keys
- 🔴 Paste the six Intuit app URLs (all built and live) — [DEPLOYMENT.md](DEPLOYMENT.md#the-five-urls-intuit-asks-for)
- 🟡 Confirm the EULA's governing jurisdiction, and have a lawyer read it
- 🔴 **Set up your authenticator** — your next sign-in requires it
- 🔴 Push to GitHub so the security workflow and Dependabot start running
- 🟡 Require two-factor on the Slack workspace (slash commands are otherwise one factor)
- 🔴 Deploy to Vercel + Railway · rotate the two passwords typed into chat
- 🟡 **0 projects, 0 people, 0 hours logged** — §12–§16 and §13 are built and have nothing to show. This is the biggest unlock.
- 🟡 26 transactions uncategorised — 26% of 90-day spending
