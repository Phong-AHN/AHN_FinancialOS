# AHN Financial OS / AI CFO — MVP Sprint Plan

**7 days, 1 builder, real money data.**

The original spec has 29 sections. There's no building all of it in a week — this plan cuts down to the one core that survives if everything else gets dropped: **know exactly where the money is, and get told the moment it moves.** Everything else queues up in the post-week-1 roadmap.

| | |
|---|---|
| **Week 1 scope** | Cash visibility + Every-dollar alert |
| **Ingestion** | Real API where feasible, CSV fallback where blocked |
| **Team** | 1 person + AI coding tools |
| **Start** | Wed, Aug 26 2026 |

---

## 1. Scope reality check

Going with real APIs from day one is the right call for most sources. But three of them run into blockers that no amount of coding speed — AI tools or not — can shrink into a week:

| Source | Reality | Week-1 handling |
|---|---|---|
| **QuickBooks Online** | Production keys are issued immediately when you create an app in Intuit Developer — no App Store review needed since this is an internal, non-public app. Genuinely feasible by Day 2. | ✅ Real API |
| **US bank / cards (Plaid)** | Plaid's "Development" environment lets you connect up to 100 real bank accounts right away, no Production approval wait. Plenty for an MVP. | ✅ Real API |
| **Stripe / PayPal** | Open REST API, keys available instantly. No blocker. | ✅ Real API |
| **Vietnamese banks** | Open banking API for individual developers essentially doesn't exist in Vietnam — banks only grant business API access through a separate corporate-banking agreement, not self-serve, not achievable in a week. | ⚠️ CSV import (interim) |
| **VEEM** | VEEM's API requires going through an "API partner" sales process — not self-serve. Outside the builder's control entirely. | ⚠️ CSV import (interim) |
| **Payroll (US/VN/PH)** | Which payroll system is in use (Gusto, Deel, ADP, or a manual spreadsheet) isn't confirmed yet. Needs AHN to confirm before we know if an API even exists. | ⚠️ CSV import (interim) |

The data model is designed so every transaction — whether it arrives via API or CSV — flows through the same `transactions` table with the same fields. Once VN bank/VEEM/payroll get real APIs in Phase 2, only the ingestion source changes, not the schema or the dashboard.

---

## 2. Definition of done

By the end of Day 7, the app must:

- [ ] Show total cash on hand, by account/entity, rolling up to one correct number.
- [ ] Fire a Slack + email alert within a few minutes of any new transaction from QuickBooks, Plaid, or Stripe.
- [ ] Compute runway (months) and average burn rate with a deterministic formula, not an AI guess.
- [ ] Show this month's break-even revenue on the home screen.
- [ ] Let you click any number on the dashboard → see the underlying transactions that produced it.
- [ ] Log an audit entry (old value, new value, who, when) whenever a transaction is hand-edited (category, notes).
- [ ] Flag matching transactions between QuickBooks and Plaid as "possible duplicate" instead of double-counting them in total cash.

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| App (frontend + API routes) | Next.js 14 (App Router) + TypeScript | One codebase, deploys to Vercel in minutes, the stack AI coding tools handle best. |
| Database + Auth | Supabase (Postgres) | Schema editor built in, Row Level Security for permissions, Auth out of the box — no hand-rolled auth. |
| Recurring jobs | Vercel Cron → API route | Poll QuickBooks/Plaid/Stripe every 5–10 minutes. No separate queue system needed for week 1. |
| Accounting | QuickBooks Online API (OAuth2) | Accounting source of truth, per the product principle (spec §29). |
| US bank/cards | Plaid (Development environment) | Connects real accounts, no Production approval wait. |
| Payments | Stripe API | If AHN collects through Stripe — sync charges/payouts directly. |
| Slack | Slack API (Bot token + Incoming Webhook) | First-class per spec §5 — the primary alert channel. |
| Email | Resend | Fast setup, no complex domain warm-up needed for week one. |
| SMS | Twilio | Reserved for critical-severity alerts (low runway, unusually large outflow). |
| Hosting | Vercel | Continuous deploys, preview URL for every change for fast self-checks. |

---

## 4. Week-1 data model

10 tables, no more. Trimmed down from the 27+ entities in spec §27. Enough to answer "where's the money, where did it go, who's responsible" — no project/event/subscription tables yet (Phase 2).

| Table | Key fields |
|---|---|
| `companies` | id, name, entity_country (US/VN/PH), currency |
| `financial_accounts` | id, company_id, name, type, currency, source_system, external_account_id |
| `integrations` | id, provider (qbo/plaid/stripe), status, access_token (encrypted), last_synced_at |
| `counterparties` | id, name, type (vendor/customer), source_system |
| `transactions` | id, account_id, counterparty_id, date, amount, currency, direction, category, source_system, external_txn_id (dedup key), reconciliation_status, notes |
| `alert_rules` | id, type, threshold, channels[], severity, enabled |
| `notifications` | id, alert_rule_id, transaction_id, channel, sent_at, status |
| `users` | id, email, role (owner/viewer), auth_id |
| `audit_logs` | id, table_name, record_id, field, old_value, new_value, user_id, changed_at |
| `manual_imports` | id, source_label (vn_bank/veem/payroll), file_name, imported_by, imported_at, row_count |

---

## 5. Architecture

One direction, no loops back:

```
Sources (QBO · Plaid · Stripe · CSV)
        │
        ▼
Sync layer (cron poll, dedup by external_txn_id)
        │
        ▼
Postgres (normalized transactions)
        │
        ▼
Calc engine (cash · burn · runway · break-even)
        │
        ▼
Alert engine (rule match → format message)
        │
        ▼
Dashboard + Slack/Email/SMS (viewer)
```

---

## 6. 7-day schedule

Sequential — each day builds on the last, no parallelizing since it's one person. Day 0 doesn't count toward the 7 days; it happens before the sprint starts.

### Day 0 — Wed, Aug 26 — Account & environment setup

*No code — just unlocking everything the week ahead needs.*

- Create the Supabase project, the Next.js + TS repo, connect Vercel.
- Register on Intuit Developer, create the QuickBooks app, get a production key for AHN's real company.
- Register with Plaid, activate the Development environment, get the client_id/secret.
- Create the Slack app: bot token + incoming webhook, create the `#ahn-finance-alerts` channel.
- Sign up for Twilio (SMS number) and Resend (email).
- Gather sample CSVs: VN bank statement, VEEM history, most recent payroll export.
- Confirm with the team which payroll system is actually in use.

### Day 1 — Thu, Aug 27 — Schema + auth + app shell

*Goal: a running app you can log into, that can load one CSV into the right table.*

- Migrate the 10 data-model tables into Supabase.
- Basic auth via Supabase Auth (owner login).
- Layout: sidebar + CEO home screen (placeholder numbers).
- Generic CSV import module: user-chosen column mapping → `transactions` table.

**Deliverable:** Can log in, import one sample CSV, see the transactions land in the DB.
`Spec §3 · §22 · §27`

### Day 2 — Fri, Aug 28 — QuickBooks (real API)

*Goal: connect AHN's actual QuickBooks company and pull real transactions.*

- OAuth2 "Connect QuickBooks" flow.
- Sync Deposits, Purchases, Bills, Invoices via the API.
- Store into `transactions` with `source_system='quickbooks'`, dedup on `qbo_txn_id`.

**Deliverable:** Click "Connect QuickBooks" → real transactions flow into the dashboard.
`Spec §2 · §3`

### Day 3 — Sat, Aug 29 — Plaid (US bank/cards) + Stripe + dedup

*Goal: merge multiple sources without double-counting.*

- Plaid Link: connect US bank accounts + credit cards.
- Sync via the Plaid Transactions API, `source_system='plaid'`.
- Stripe API: fetch charges/payouts if in use.
- Basic dedup rule: match amount + date (±2 days) + account between QBO and Plaid → flag as "possible duplicate" in the unmatched queue.

**Deliverable:** Cash from all 3 sources rolls up correctly, no double-counting.
`Spec §2 · §22`

### Day 4 — Sun, Aug 30 — Alert engine (Slack, email, SMS)

*Goal: every dollar in/out fires a real alert, on the right channel.*

- Rule engine: new transaction → format message → send to Slack + email.
- SMS reserved for critical-severity alerts (unusually large outflow, runway below threshold).
- Alert config page: toggle channels per transaction type.
- End-to-end test: create a test transaction → receive the alert within seconds.

**Deliverable:** "Every-dollar alert" running for real across QBO + Plaid + Stripe.
`Spec §4 · §5 · §6`

### Day 5 — Mon, Aug 31 — Cash, burn, runway, break-even

*Goal: answer the core questions correctly, with deterministic formulas.*

- Total cash by account/entity/company.
- Burn rate = average outflow over the last 3 months.
- Runway = cash on hand / burn rate.
- Break-even revenue = total expected expense for the current month.
- CEO home screen: cash, revenue MTD, expense MTD, net profit, runway, break-even, "needs attention".

**Deliverable:** The home screen answers the 7 questions in spec §21.
`Spec §9 · §10 · §21`

### Day 6 — Tue, Sep 1 — Drill-down, audit log, real VN data

*Goal: every number traceable to its source; hand-edits leave a trail.*

- Click a dashboard number → the underlying transaction list.
- "Unmatched transactions" + "missing category" queues.
- Audit log for hand-edits: old value, new value, who edited, when.
- Import real CSVs: AHN's VN bank statements, VEEM, payroll — so the dashboard reflects 100% of real cash, not just the API-connected part.

**Deliverable:** Every dashboard number drills down to source transactions; cash includes VN/VEEM/payroll too.
`Spec §17 · §22 · §24`

### Day 7 — Wed, Sep 2 — Roles, basic security, demo

*Goal: ready to hand to the CEO for real use.*

- 2 roles: Owner (full access) / Viewer (read-only, payroll detail hidden).
- Row Level Security enabled on Supabase, secrets in environment variables, nothing hard-coded.
- Re-run the full "definition of done" checklist from section 2.
- Prep the demo: one end-to-end test transaction in front of the CEO.

**Deliverable:** MVP ready to demo, meeting the week-1 acceptance checklist.
`Spec §23 · §25 · §28`

---

## 7. Week-1 alert spec

| Type | Trigger | Channel | Severity |
|---|---|---|---|
| Money in | Any new inflow transaction, any amount | Slack, Email | Info |
| Money out | Any new outflow transaction, any amount | Slack, Email | Info |
| Unusually large outflow | Above configured threshold (e.g. > $5,000/transaction) | Slack, Email, SMS | Warning |
| Low runway | Below configured threshold (e.g. < 6 months) | Slack, Email, SMS | Critical |
| Low account balance | Account balance below threshold | Slack, Email, SMS | Critical |
| Daily/weekly summary | Fixed schedule (9am daily / Monday weekly) | Slack, Email | Digest |

**Example alert format** (matching the templates in spec §4):

```
+$12,500 received from Client X. Account: US Operating. Current total cash: $284,300.

−$4,800 sent via VEEM for Philippines payroll. Monthly payroll spend: $31,400. Runway: 7.8 months.
```

---

## 8. Out of scope this week

Each item below needs its own data model or workflow — cramming it into week 1 would slow down or break cash visibility + alerting, the actual goal.

**Pushed to Phase 2**
- Subscription intelligence (price increases, duplicates, cut recommendations) — spec §8
- Project-level P&L, Events P&L — spec §12, §14
- Time tracking & labor cost — spec §13
- Revenue growth / margin simulator — spec §11
- Budget vs. actual — spec §19
- Real APIs for VN bank, VEEM, payroll (once agreements/confirmation are in place)

**Pushed to Phase 3**
- Full AI CFO layer (explanations, anomaly detection) — spec §20
- Full 7-role RBAC — spec §23 (week 1 only has Owner/Viewer)
- Complete multi-currency reporting (automatic VND/USD conversion)
- Google Workspace billing, automated SaaS vendor API tracking
- Slack slash commands / natural-language financial queries

---

## 9. Risks

| Risk | Why | Mitigation |
|---|---|---|
| Payroll system not yet known | Not knowing Gusto/Deel/ADP/manual means not knowing whether the CSV already has a usable format or needs manual entry. | Confirm with AHN on Day 0, before Day 1 starts. |
| VN bank/VEEM data only lands in the final days | CSV import happens Day 6 — if sample files aren't available early, the "100% real cash" part of the dashboard slips. | Request sample files on Day 0, even old months' data, just to test the import. |
| Dedup between QBO and Plaid isn't perfect | The amount+date+account match rule is a heuristic, not an exact match — it can miss duplicates or flag the wrong ones. | Accept it as "basic" for week 1, with a queue for manual confirmation; improve the algorithm in Phase 2. |
| One person carrying all 7 days back-to-back | No buffer if a day gets blocked by an API error or an account-setup snag. | Do Day 0 thoroughly to reduce technical blockers; if a day slips, cut that day's "nice-to-have" items rather than pushing them into the next day. |

---

## 10. Acceptance checklist

Mapped against the original spec's §28.

| Criterion (spec §28) | Status |
|---|---|
| Every imported dollar traceable to its source transaction | ✅ Week 1 |
| No double-counting between bank feed and QuickBooks | ✅ Week 1 (basic) |
| Cash balance reconciles with connected accounts | ✅ Week 1 |
| Every-dollar alerts via Slack, SMS, email | ✅ Week 1 |
| Runway based on actual cash and burn | ✅ Week 1 |
| Monthly break-even revenue | ✅ Week 1 |
| Model revenue growth & target margin | ⏳ Later |
| Profitability for every project/event | ⏳ Later |
| Labor/time factored into profitability | ⏳ Later |
| Subscription price changes auto-flagged | ⏳ Later |
| Drill from company KPI down to transaction | ✅ Week 1 |
| Audit trail for financial-data changes | ✅ Week 1 (basic) |

---

## 11. After week 1

Finishing week 1 doesn't mean stopping — it's the foundation the remaining 21 spec sections plug into without a data-model rebuild. Suggested sequence below, with no firm timing since it depends on whether VN bank/VEEM/payroll ever confirm API access:

- **Phase 2:** Subscription intelligence + Project/Event P&L — high value, no dependency on a third party outside our control.
- **Phase 2:** Pursue/confirm real API access for VN banks (via corporate banking) and VEEM (via sales) — runs in parallel, doesn't block anything else.
- **Phase 3:** A real AI CFO layer (explaining swings, suggesting cuts) once there are 2-3 months of clean data for it to actually analyze.
- **Phase 3:** Full RBAC, budget vs. actual, revenue/margin simulator.

---

*This plan is a starting point, not a fixed contract — if Day 2 reveals AHN's QuickBooks needs an extra verification step, or Plaid doesn't support a particular bank, cut that day's least-important item and hold the line on the week's real goal: cash visibility + every-dollar alerting, running for real.*
