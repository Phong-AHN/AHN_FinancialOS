# Outstanding work

Tracked against the 7-day schedule in [AHNFinancialOSMVPPlan.md](../AHNFinancialOSMVPPlan.md).

**Days 1–7 are complete and Phase 2 has started.** The code is written, typechecked
and tested against live data. Everything in **Your checklist** below needs AHN — a
credential, a third party's approval, or a decision only AHN can make. Nothing there
is waiting on more engineering.

Legend: 🔴 blocks go-live · 🟡 degrades quality · ⚪ optional

**Where the data stands right now** (27 Aug 2026): 135 transactions — 66 QuickBooks,
49 Plaid, 20 Stripe — across 20 accounts, 9 of them counted as cash. All three
connectors report `connected` and synced today. 26 transactions are still
uncategorised, 0 are flagged as possible duplicates. Every account is USD; there is
no VND or VEEM data yet. `npm run db:seed` restores the demo company if a
walkthrough is ever wanted.

---

# YOUR CHECKLIST

Ordered so the things with the longest lead time start first.

## 1. Start today — these wait on someone else

| | Task | What to do | Why it cannot wait |
|---|---|---|---|
| 🔴 | **Apply for Plaid Production access** | dashboard.plaid.com → Team Settings → Company → request Production. Expect an application form and a review. | Plaid **retired** the Development environment; `development.plaid.com` no longer resolves. Real US bank data has no other route. The plan assumed self-serve — it is not. Sandbox proves the pipeline meanwhile. |
| 🔴 | **Get the QuickBooks *production* key pair** | developer.intuit.com → your app → **Production Settings** → Keys. Intuit issues a **separate pair per environment**, so the sandbox keys will not work. | Everything currently in the app came from a *sandbox* company. None of it is AHN's real money. |
| ⚪ | **VN bank corporate API agreement** | Contact the bank's corporate banking desk. | Phase 2. CSV import covers the meantime. |
| ⚪ | **VEEM API partner process** | Apply through VEEM's partner programme. | Phase 2. CSV import covers the meantime. |

## 2. Credentials to paste into `.env.local`

Restart the server after every change — env vars are read once, at process start.

| | Variable | Where to get it | Status today |
|---|---|---|---|
| 🟡 | `RESEND_API_KEY`, `ALERT_EMAIL_TO` | resend.com → API Keys | **empty** — 71 email alerts have been recorded as `skipped`. Email is the only channel that survives someone leaving Slack. |
| 🟡 | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ALERT_SMS_TO` | twilio.com → Console | **empty** — critical alerts have no SMS path. 2 have been skipped so far. |
| ⚪ | `STRIPE_SECRET_KEY` | dashboard.stripe.com/apikeys — `sk_live_…` | A **test-mode** key is in use and working (20 transactions). Swap for a live key only if AHN actually collects through Stripe. |

Already set and verified: Supabase, `ENCRYPTION_KEY`, `CRON_SECRET`, QuickBooks
(sandbox), Plaid (sandbox), Slack (bot authenticates as `ahn_financialos` in *AHN DEV
TEST*, 71 alerts delivered).

## 3. Decisions only you can make

| | Decision | What hangs on it |
|---|---|---|
| 🔴 | **Switch QuickBooks to production** | Needs the key pair from §1 **and** the deployed URL registered as a redirect URI under Production Settings. Until then every figure on every page is sandbox data. |
| 🟡 | **Confirm the alert thresholds** on `/alerts` | Defaults: unusually-large outflow > $5,000, low runway < 6 months, low balance < $10,000. |
| 🟡 | **Decide the runway floor** | Runway now reads **10.1 months** if revenue stopped, 15.2 at current net burn, 5.6 in the worst month on record. It read 3.6 while credit-card settlements were wrongly counted as spend. If 6 months is not AHN's real floor, change it on `/alerts`. |
| 🟡 | **Check where payroll sits in AHN's production QuickBooks** | Plan Risk #1. AHN runs payroll through QuickBooks so no CSV is needed, but the sandbox holds no payroll, so which entity carries it is unknown. Run `QBO_INVENTORY=1 npx vitest run tests/qbo-inventory.integration.test.ts` against production: if pay runs appear as `JournalEntry` the connector needs extending; as `Purchase`/`BillPayment` it is already covered. |
| ⚪ | **Decide who else gets access** | Add people with `node scripts/create-user.mjs <email> <password> owner\|viewer`. |
| ⚪ | **Set a real USD/VND rate** | Seeded at `0.000038`. **No effect today** — all 20 accounts are USD and there are zero non-USD transactions. This becomes 🔴 the moment VN bank data is imported. |

## 4. Before real money runs through this

| | Task | Notes |
|---|---|---|
| 🔴 | **Deploy the app to Vercel and the scheduler to Railway** | Walkthrough in [DEPLOYMENT.md](DEPLOYMENT.md). Both need the *same* `CRON_SECRET`; the app needs `NEXT_PUBLIC_APP_URL` because alert deep links point at it. |
| 🔴 | **Set the Railway service region to Tokyo** | `vercel.json` already pins the app to `hnd1`, beside the Supabase project in `ap-northeast-1`. Railway has no config file for this — set it in Settings → Region. A worker on another continent pays a full ocean crossing on every scheduled run. |
| 🔴 | **Rotate two passwords that were typed into a chat window** | The owner login `pinlo752004@gmail.com`, and the Supabase database password — they are currently the same string, which means one leak is two. |
| 🟡 | **Run `npm run smoke` against the deployment** | `npm run smoke -- you@example.com 'password' https://your-app.vercel.app`. It signs in and loads all nine pages, which nothing else in the suite does. |
| 🟡 | **Verify the scheduler fires** | Open `https://<worker>.up.railway.app/health` — it reports runs and failures per job and answers 503 once anything has failed. **Set `TZ` on the Railway service** or the daily digest fires at UTC 09:00, which is 16:00 in Vietnam. |
| 🟡 | **Import AHN's real VN bank and VEEM exports** | The last piece of Day 6. Payroll is not needed — it comes through QuickBooks. Templates in [`samples/`](../samples/). VEEM rows categorise themselves from the source, so the mapping only has to identify the date and amount columns. |
| 🟡 | **Set opening balances** on the VN bank and VEEM accounts | Otherwise their derived balances will not reconcile. `/reconcile` shows the gap. |
| 🟡 | **Clear the 26 uncategorised transactions** | Mostly QuickBooks `BillPayment` rows, which carry no expense account. Categorise on `/transactions?uncategorized=1`, or press **Re-run categorisation** on `/reconcile` after a rule is added. |
| 🟡 | **Delete ~80 stray Slack messages by hand** | Posted through the incoming webhook, which carries a different bot identity, so `chat.delete` refuses them (`cant_delete_message`). Removing `SLACK_WEBHOOK_URL` from `.env.local` stops that identity being usable at all — the bot token covers every channel already. |
| 🟡 | **Delete `viewer-test@asianhustlenetwork.com`** | Its password has been re-randomised so nobody can sign in, but the account still exists. It was created to prove RLS and has now done so twice. |

## 5. Whenever a security policy changes

| | Task |
|---|---|
| 🟡 | **Re-run the RLS check** — `RLS_TEST=1 VIEWER_EMAIL=… VIEWER_PASSWORD=… npx vitest run tests/rls.integration.test.ts`. A policy that quietly stops restricting fails silently, and nothing else in the suite would notice. This has already caught one real payroll leak, and a second reached the app through an unrelated route (decision 44). |

---

# ENGINEERING BACKLOG — no action needed from you

## Phase 2, in progress: subscription intelligence (spec §8)

**Built.** `/subscriptions` finds recurring charges from the payments themselves,
never from the `is_subscription` flag: same vendor, at least three times, even gaps,
and amounts sitting on one or two repeated prices. Live it reports **11 charges at
$8,049/mo**. See decisions 42–45.

It deliberately does not claim a charge is unused, or that cancelling it would save a
stated amount — payment data cannot support either.

**Price-increase alerts are live.** A rise fires once per vendor per change on
Slack and email, at `warning` severity, when it clears **both** floors: at least
10% AND at least $50/year of extra cost. Both are editable on `/alerts`. It runs
as its own daily job (`/api/cron/price-increases`), not on the sync tick.

| | Remaining |
|---|---|
| 🟡 | **A table for the human-supplied §8 fields** — owner, department, whether anyone still uses it, cancellation notice. These four turn the list into a decision and none can be derived from a payment. Needs one short conversation about who fills them in. |
| 🟡 | **Separate payroll from the cancellable list** — $5,850/mo of Gusto is correctly recurring, and its lapse would be worth an alert, but it is not something anyone cancels. |

## Phase 2 / Phase 3, not started

Project & event P&L · time tracking & labour cost · revenue growth and margin
simulator · budget vs. actual · the full AI CFO layer · the complete 7-role RBAC ·
automated multi-currency rate feed · Slack slash commands.

The schema is shaped so these attach without a rebuild: `is_subscription` and
`is_recurring` are populated on every transaction, categories follow the spec §7
taxonomy, and counterparties are already normalised and deduplicated.
