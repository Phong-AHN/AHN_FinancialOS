# Outstanding work

Tracked against the 7-day schedule in [AHNFinancialOSMVPPlan.md](../AHNFinancialOSMVPPlan.md).

**Code for Days 1–7 is written, typechecked and tested.** Everything below is either
a credential AHN has to obtain, a third party that has to approve something, or a
decision only AHN can make. Nothing here is blocked on more engineering.

Legend: 🔴 blocks a Definition-of-Done item · 🟡 degrades quality · ⚪ optional

**Demo data has been removed.** The database now holds only what the connectors
fetched: 115 transactions — 66 from QuickBooks, 49 from Plaid — across 18
accounts. `npm run db:seed` puts the demo company back if it is ever wanted for a
walkthrough.

---

## Blocked on a third party — start these first, they have lead time

| | Item | Why it matters | Who |
|---|---|---|---|
| 🔴 | **Apply for Plaid Production access** | Plaid **retired** the Development environment (`development.plaid.com` no longer resolves). Real US bank data now needs Production, which has an application and a review. The plan assumed this was self-serve; it is not. Sandbox proves the pipeline meanwhile. | AHN → Plaid |
| 🟡 | **Check where payroll sits in AHN's PRODUCTION QuickBooks** | Plan Risk #1, now narrowed: AHN runs payroll through QuickBooks, so no CSV is needed. But the sandbox holds no payroll at all, so which entity carries it is still unknown. Run `QBO_INVENTORY=1 npx vitest run tests/qbo-inventory.integration.test.ts` against the production company: if pay runs appear as `JournalEntry`, the connector needs extending; if as `Purchase`/`BillPayment`, it is already covered. | AHN internal |
| ⚪ | **VN bank corporate API agreement** | Phase 2 per plan §8. CSV import covers week 1. | AHN → bank |
| ⚪ | **VEEM API partner process** | Phase 2 per plan §8. CSV import covers week 1. | AHN → VEEM |

---

## Credentials to obtain and paste into `.env.local`

Restart the server after every change — env vars are read once, at process start.

| | Item | Where | Status |
|---|---|---|---|
| ⚪ | `PLAID_CLIENT_ID`, `PLAID_SECRET` | dashboard.plaid.com → Team Settings → Keys | **set and verified** — sandbox keys, accepted by Plaid, one sandbox bank connected and syncing (49 transactions, 14 accounts) |
| 🟡 | `STRIPE_SECRET_KEY` | dashboard.stripe.com/apikeys — `sk_live_…` for real data | **empty** (skip entirely if AHN does not collect through Stripe) |
| 🟡 | `RESEND_API_KEY`, `ALERT_EMAIL_TO` | resend.com | **empty** — email alerts are recorded as `skipped` until set |
| 🟡 | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ALERT_SMS_TO` | twilio.com | **empty** — critical alerts have no SMS path |

Already set and verified working: Supabase, `ENCRYPTION_KEY`, `CRON_SECRET`,
QuickBooks (key pair accepted by Intuit), Slack (bot token authenticates as
`ahn_financialos` in *AHN DEV TEST*).

---

## Decisions only AHN can make

| | Decision | Consequence |
|---|---|---|
| 🔴 | **Sandbox or production for QuickBooks?** | **Sandbox is connected and syncing** — 66 transactions pulled, last sync 26 Aug 11:06. But it is a *sandbox* company, not AHN's real books. Production needs the environment switched **and** the production key pair; Intuit issues a separate pair per environment. |
| ⚪ | **Register the redirect URI on the Intuit app** | Done for sandbox — the OAuth round trip completed. Production will need the deployed URL registered under Production Settings. |
| ⚪ | **Slack** | **Done and verified delivering.** The bot reaches all four routed channels; the Day-4 end-to-end test now reports `slack sent` for both an info alert and a warning, each landing in its own channel. Token scopes: `chat:write`, `channels:join`, `channels:history`, `commands`, `incoming-webhook`. Adding `channels:read` would additionally let the app resolve a `#name` to an ID and rejoin a channel by itself — see decision 28. |
| 🟡 | **Confirm the alert thresholds** | Defaults are unusually-large-outflow > $5,000, low-runway < 6 months, low-balance < $10,000. Editable on `/alerts`. |
| 🟡 | **Set a real USD/VND rate** | Seeded at `0.000038`. Every VND balance in the USD rollup depends on it. Phase 2 replaces the seed with a feed. |
| ⚪ | **Decide who else gets access** | Only `pinlo752004@gmail.com` (owner) exists. Viewers are read-only with payroll hidden by RLS policy. |

---

## Before this is used on real money

| | Item |
|---|---|
| 🔴 | **Deploy and set the production env vars** on Vercel, including `NEXT_PUBLIC_APP_URL` (alert deep links point at it) and `CRON_SECRET`. |
| 🟡 | **Run `npm run smoke` against the deployment** once it is up — `npm run smoke -- you@example.com 'password' https://your-app.vercel.app`. It signs in and loads every page, which nothing else in the suite does. |
| 🟡 | **Verify the cron actually fires** in production — `vercel.json` schedules sync every 10 min, digests at 09:00 daily and Monday. |
| 🟡 | **Delete ~80 stray Slack messages by hand** — they were posted through the incoming webhook, which carries a different bot identity, so `chat.delete` refuses them (`cant_delete_message`). They are all labelled alerts about historical transactions. Removing `SLACK_WEBHOOK_URL` from `.env.local` would stop the webhook identity being usable at all; the bot token covers everything. |
| 🟡 | **Rotate the password** shared in chat for `pinlo752004@gmail.com`. |
| 🟡 | **Set opening balances** on the VN bank and VEEM accounts so their derived balances reconcile — the Reconcile page shows the gap. |
| 🟡 | **Import AHN's real VN bank and VEEM exports** — the last piece of Day 6. Payroll is not needed: it comes through QuickBooks. Templates in [`samples/`](../samples/) show the expected shapes. VEEM rows now categorise themselves from the source, so the mapping only has to get the date and amount columns right. |
| 🟡 | **Clear the last 15 uncategorised transactions** — mostly QuickBooks `BillPayment` rows, which carry no expense account. Categorise by hand on `/transactions?uncategorized=1`, or press **Re-run categorisation** on `/reconcile` after adding a rule. |
| 🟡 | **Decide the runway floor** — the 6-month threshold now fires on the honest figure, and currently reports 3.6 months. If 6 is not AHN's real floor, change it on `/alerts`. |

---

## Phase 2 / Phase 3 — explicitly out of week-1 scope (plan §8)

Subscription intelligence · project & event P&L · time tracking & labour cost ·
revenue growth and margin simulator · budget vs. actual · the full AI CFO layer ·
the complete 7-role RBAC · automated multi-currency rate feed · Slack slash commands.

The schema is shaped so these attach without a rebuild: `is_subscription` and
`is_recurring` are already populated on every transaction, categories already follow
the spec §7 taxonomy, and counterparties are already normalised and deduplicated.
