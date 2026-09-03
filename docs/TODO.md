# Outstanding work

Tracked against the 7-day schedule in [AHNFinancialOSMVPPlan.md](../AHNFinancialOSMVPPlan.md).
For what is already built, see [DONE.md](DONE.md).

## Where the plan stands (3 Sep 2026)

| Plan stage | Status |
|---|---|
| **Week 1, Days 1–7** — plan §6 | **Complete.** Ingestion, calc engine, alerting, CEO home screen, drill-down, roles, audit. |
| **Phase 2** — plan §8 | **Every feature built.** §8 subscriptions, §12/§14/§15 project & event P&L, §16 roll-up, §13 time & labour, §11 simulator, §19 budgets, §17/§18 receivables & payables. One item still open and it is not code: **real API access for the VN banks and VEEM**, which waits on AHN's registration. |
| **Phase 3** — plan §8 | **Four of five built.** §23 seven-role RBAC, automatic VND/USD conversion, Slack slash commands, and the deterministic half of the §20 AI CFO layer. |
| **Not started** | The *interpretation* half of §20, gated on 2–3 months of clean data — plan §11 says so, and the ledger holds 135 sandbox rows. Google Workspace / SaaS vendor billing APIs, which need per-vendor credentials. |

**So: the engineering is not what the project is waiting on.** Everything in
**Your checklist** below needs AHN — a credential, a third party's approval, or a
decision only AHN can make. The engineering backlog underneath it is one
quality item and six optional ones.

Legend: 🔴 blocks go-live · 🟡 degrades quality · ⚪ optional

> **Verifying locally on this machine:** port 3000 and 3100 belong to
> `AHN_MigrateToolSHOPLINE`, which is usually running. Start this app on another
> port — `PORT=3777 npm run start` — and pass the base URL to the smoke script:
> `npm run smoke -- <email> '<password>' http://localhost:3777`. Without that,
> every request is answered by the other application and every page looks
> broken. See decision 92.

**Where the data stands right now** (3 Sep 2026): 135 transactions — 66 QuickBooks,
49 Plaid, 20 Stripe — across 20 accounts, 9 of them counted as cash. All three
connectors report `connected`. 26 transactions are still uncategorised, 0 are
flagged as possible duplicates. **46 receivables and payables** now sync from
QuickBooks. Every account is USD and the VND rate refreshes daily from
Vietcombank, but there is still no VND or VEEM data. **0 projects, 0 people, 0
hours logged** — which is why §12–§16 and §13 render empty despite being built.
`npm run db:seed` restores the demo company if a walkthrough is ever wanted.

---

# YOUR CHECKLIST

Ordered so the things with the longest lead time start first.

## 1. Start today — these wait on someone else

| | Task | What to do | Why it cannot wait |
|---|---|---|---|
| 🔴 | **Apply for Plaid Production access** | dashboard.plaid.com → Team Settings → Company → request Production. Expect an application form and a review. | Plaid **retired** the Development environment; `development.plaid.com` no longer resolves. Real US bank data has no other route. The plan assumed self-serve — it is not. Sandbox proves the pipeline meanwhile. |
| 🔴 | **Get the QuickBooks *production* key pair** | developer.intuit.com → your app → **Production Settings** → Keys. Intuit issues a **separate pair per environment**, so the sandbox keys will not work. | Everything currently in the app came from a *sandbox* company. None of it is AHN's real money. |
| 🔴 | **Register at [openapi.vietinbank.vn](https://openapi.vietinbank.vn) and send five values** | Create an account → create an application → the Client ID and Secret are issued **instantly**, no approval wait. The secret is shown once. | **The connector is written and tested against the bank's own example response.** These five values are the only thing between it and live Vietnamese corporate data. |
| 🟡 | **Get Finverse credentials** | [finverse.com](https://www.finverse.com/bank-data-api) → dashboard. | The fallback, and probably not the right one: Finverse lists VietinBank and Techcombank as *individual accounts only*. Worth a direct question to them before spending time here. |
| ⚪ | **Techcombank Open API** | No public self-serve sandbox — apply through business banking. | Blocked on the bank. CSV import covers the meantime and now imports correctly. |

### What I need from you for VietinBank

The API specification arrived, so the connector is **written**: request builder,
statement parser, account and transaction mapping, and the sync wired into the
scheduler. 23 tests cover it, including the bank's own documented example
response.

## 2. The five VietinBank values

**The sandbox has been reached.** A live call returns
`401 Invalid client id or secret` in 230ms — which proves the host, the path,
the method and the header-based authentication are all correct. The values
currently in `.env.local` are `apiKey located in header`, the Swagger
document's *description* of the header rather than a key. Only real credentials
are missing.

| | What | Goes in |
|---|---|---|
| 🔴 | `VIETINBANK_CLIENT_ID`, `VIETINBANK_CLIENT_SECRET`, `VIETINBANK_ACCOUNT_NUMBER`, `VIETINBANK_PROVIDER_ID`, `VIETINBANK_MERCHANT_ID` | openapi.vietinbank.vn → your application | **empty** — the five values above. `/integrations` names exactly which are missing. |
| 🔴 | **Client Secret** | `VIETINBANK_CLIENT_SECRET` — sent as `X-IBM-Client-Secret`. Shown **once**, at creation |
| 🔴 | **The account number** to pull | `VIETINBANK_ACCOUNT_NUMBER` — the statement API answers for one account per call |
| 🔴 | **Mã nhà cung cấp dịch vụ** | `VIETINBANK_PROVIDER_ID` — VietinBank assigns it |
| 🔴 | **Mã merchant** | `VIETINBANK_MERCHANT_ID` — VietinBank assigns it |

The last two matter more than they look: a wrong one is answered with a status
code **inside a 200 response**, not an HTTP error, so it fails quietly. The
connector reads the status and reports it, but it cannot invent the right value.

**Then press Connect on `/integrations`.** It asks for one week of statement and
reads the status code out of the body — proving the keys, the account number and
the partner identifiers all work before anything is stored.

Two things that may still come back from the bank:

- **Signing.** The request schema has a `signature` field but documents neither
  the algorithm nor what to sign. Requests go unsigned. If the sandbox refuses
  them, ask the portal for the signing documentation — that needs an **RSA key
  pair**, not another secret.
- **A production host.** The specification lists the sandbox URL for both
  "production" and "development". Going live needs the real address in
  `VIETINBANK_API_BASE`; there is deliberately no default to fall back on.

## 3. Decisions only you can make

| | Decision | What hangs on it |
|---|---|---|
| 🔴 | **Switch QuickBooks to production** | Needs the key pair from §1 **and** the deployed URL registered as a redirect URI under Production Settings. Until then every figure on every page is sandbox data. |
| 🟡 | **Confirm the alert thresholds** on `/alerts` | Defaults: unusually-large outflow > $5,000, low runway < 6 months, low balance < $10,000. |
| 🟡 | **Decide the runway floor** | Runway now reads **10.1 months** if revenue stopped, 15.2 at current net burn, 5.6 in the worst month on record. It read 3.6 while credit-card settlements were wrongly counted as spend. If 6 months is not AHN's real floor, change it on `/alerts`. |
| 🟡 | **Check where payroll sits in AHN's production QuickBooks** | Plan Risk #1. AHN runs payroll through QuickBooks so no CSV is needed, but the sandbox holds no payroll, so which entity carries it is unknown. Run `QBO_INVENTORY=1 npx vitest run tests/qbo-inventory.integration.test.ts` against production: if pay runs appear as `JournalEntry` the connector needs extending; as `Purchase`/`BillPayment` it is already covered. |
| ⚪ | **Decide who else gets access** | Add people with `node scripts/create-user.mjs <email> <password> owner\|viewer`. |
| ⚪ | **Keep the USD/VND rate current** | Now editable on `/accounts` — entered as dong-to-the-dollar, stored dated so old reports keep old rates. Currently 26,100 (set by hand, 27 Aug). It converts every dong in the ledger, so it is worth a glance whenever VND data is imported. |

## 4. Before real money runs through this

| | Task | Notes |
|---|---|---|
| 🔴 | **Deploy the app to Vercel and the scheduler to Railway** | Walkthrough in [DEPLOYMENT.md](DEPLOYMENT.md). Both need the *same* `CRON_SECRET`; the app needs `NEXT_PUBLIC_APP_URL` because alert deep links point at it. |
| 🔴 | **Set the Railway service region to Tokyo** | `vercel.json` already pins the app to `hnd1`, beside the Supabase project in `ap-northeast-1`. Railway has no config file for this — set it in Settings → Region. A worker on another continent pays a full ocean crossing on every scheduled run. |
| 🔴 | **Rotate two passwords that were typed into a chat window** | The owner login `pinlo752004@gmail.com`, and the Supabase database password — they are currently the same string, which means one leak is two. |
| 🟡 | **Run `npm run smoke` against the deployment** | `npm run smoke -- you@example.com 'password' https://your-app.vercel.app`. It signs in and loads all nine pages, which nothing else in the suite does. |
| 🟡 | **Set `BUSINESS_TIME_ZONE=Asia/Ho_Chi_Minh` on Vercel** | It defaults to that already, so this is only needed if the value should differ. It must match the worker's `TZ`: one decides when jobs fire, the other decides what date the app calls “today”. |
| 🟡 | **Verify the scheduler fires** | Open `https://<worker>.up.railway.app/health` — it reports runs and failures per job and answers 503 once anything has failed. **Set `TZ` on the Railway service** or the daily digest fires at UTC 09:00, which is 16:00 in Vietnam. |
| 🟡 | **Import AHN's real VN bank and VEEM exports** | The last piece of Day 6. Payroll is not needed — it comes through QuickBooks. Templates in [`samples/`](../samples/). VEEM rows categorise themselves from the source, so the mapping only has to identify the date and amount columns. **Create the VND account first** (Accounts → the account's currency decides how its amounts are parsed). The VN statement template now imports correctly end to end — see decisions 61–62 for the two bugs that found. |
| ⚪ | **Decide whether your hand-set VND rate should stand** | You set 1 USD = 26,100 VND by hand for 1 and 2 September. The daily feed defers to a rate a person set, so those two days keep your number and Vietcombank’s 26,260 is ignored — which is the designed behaviour, not a fault. From 3 September the feed writes on its own. Delete those two rows only if you would rather the bank’s rate applied. |
| 🟡 | **Set opening balances** on the VN bank and VEEM accounts | Otherwise their derived balances will not reconcile. `/reconcile` shows the gap. |
| 🟡 | **Expect 25 overdue-invoice alerts the first time you re-enable alerting** | Every alert rule is currently off. QuickBooks' AR is now synced, and all 25 open items are already past due — the oldest by 74 days — because they are sandbox invoices. Each alerts once and then dedupes, but the first sweep after `overdue_receivable` goes back on will be 25 messages. Clear or void them in QuickBooks first if you would rather not. |
| 🟡 | **Add your people and link them to logins** | `/timesheet` shows “your login is not linked to a person yet” until somebody creates a `people` row with your `user_id` on it — hours are recorded against a person, not a login, because a contractor can have one without the other. Add people on **/people** and set **Logs in as** on the same row — no SQL needed. Without this, §13 stays empty and every project margin keeps its “labour not counted” caveat. |
| 🟡 | **Create AHN's projects and events, and attribute money to them** | There are **0 projects** and **0 transactions attributed to one**, so every §12/§14/§15/§16 figure — project P&L, event P&L, and the whole profitability roll-up — currently has nothing to show. The five business units from §15 are already seeded. Create projects on `/projects`, then assign transactions from the transaction page. This is the single biggest unlock left: the engine and the pages are built and waiting on data only AHN has. |
| 🟡 | **Clear the 26 uncategorised transactions** | This is now measured rather than guessed at: `/explain` puts it at **26% of everything AHN spent in the last 90 days — $8,173.54 across 25 payments**. Every category breakdown, every budget and every driver list on the site is that much less useful until it is cleared. Mostly QuickBooks `BillPayment` rows, which carry no expense account. Categorise on `/transactions?uncategorized=1`, or press **Re-run categorisation** on `/reconcile` after a rule is added. |
| 🟡 | **Create the Slack app for slash commands** | A new command `/ahn`, request URL `https://<your-app>/api/slack/commands`. Copy the **Signing Secret** from Basic Information into `SLACK_SIGNING_SECRET`. Without it the endpoint refuses every request rather than answering unauthenticated. |
| 🟡 | **Link each person's Slack account** | On **/access** — no SQL needed. Find the id in Slack under the person's profile → *Copy member ID*. Anyone unlinked is refused by name — deliberately: being in the AHN workspace is not by itself permission to read the company's finances, and contractors and agency staff sit in that same workspace. |
| 🟡 | **Delete ~80 stray Slack messages by hand** | Posted through the incoming webhook, which carries a different bot identity, so `chat.delete` refuses them (`cant_delete_message`). Removing `SLACK_WEBHOOK_URL` from `.env.local` stops that identity being usable at all — the bot token covers every channel already. |
| 🟡 | **Appoint a second owner** | There is exactly one. The database refuses to demote the last owner, but it cannot stop that account being lost — and with no owner, nobody inside the app can appoint one. `/access` warns while this is true. |
| 🟡 | **Delete `viewer-test@asianhustlenetwork.com`** | Its password has been re-randomised so nobody can sign in, but the account still exists. It was created to prove RLS and has now done so twice. |

## 5. Whenever a security policy changes

| | Task |
|---|---|
| 🟡 | **Re-run the RLS check** — `RLS_TEST=1 VIEWER_EMAIL=… VIEWER_PASSWORD=… npx vitest run tests/rls.integration.test.ts`. A policy that quietly stops restricting fails silently, and nothing else in the suite would notice. This has already caught one real payroll leak, and a second reached the app through an unrelated route (decision 44). |

---

# ENGINEERING BACKLOG — no action needed from you

## Phase 2 — built: subscription intelligence (spec §8)

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

## Phase 2 — built: project & event P&L (spec §12, §14, §15, §16)

**Built.** `/projects` gives every project and event a P&L: cash received,
direct cost, gross profit, margin and ROI, with revenue and cost broken down by
category and every figure drilling to the transactions behind it. An event is a
project with `kind='event'` — spec §14 says to treat it as one, and the
arithmetic is identical. See decisions 51–53.

The five business units from §15 are seeded, including the twelve AHN Labs
services, and are editable rows rather than an enum.

**Attribution is manual, by design.** A bank line does not say which project it
belongs to. Open a transaction and pick the project; `/transactions?unassigned=1`
is the queue. Most overhead should stay unassigned — the page shows the
unassigned total rather than hiding it, so these P&Ls and the company P&L can be
reconciled on sight.

| | Your part |
|---|---|
| 🟡 | **Create AHN's real projects and events** and attribute the transactions. Nothing exists yet: the test project used to verify the feature was deleted afterwards, along with its attributions, because it was demo data sitting on real transactions. |
| ⚪ | **Enter contracted and invoiced values** where they are known. Both are optional and both render "not recorded" until somebody fills them in — that is deliberate, since a guessed contract value poisons every variance measured against it. |

| | Remaining engineering |
|---|---|
| 🟡 | **Software allocated to a project is still not counted** (§12). Employee labour now IS — see decision 91. Software is not an engineering gap: allocating a subscription across projects needs a basis (headcount? hours? an explicit tag?) and any choice flatters or punishes projects arbitrarily. **This one is a decision for you**, and the projects page states the gap rather than guessing. |
| ⚪ | **Editing a project** after creation — done, see decision 91. Name, status, dates, contracted/invoiced revenue and budgets, all audited. The business unit is deliberately not editable: moving a project restates two units' history. |

---

## Phase 2 — built: time tracking & labour cost (spec §13)

**Built.** `/people` records employees and contractors on any of the three
costing bases §13 names — salaried, hourly, contractor rate — and logs hours
against projects. Project pages now show **net profit** after the people who did
the work, with hours and cost variance against the estimate and labour budget.
See decisions 54–56.

**This does not add a new cost.** Payroll has already left the bank and is
counted once in the company P&L; logging time decides which projects that money
was spent on. A project only pays twice if a payroll transaction is *also*
attributed to it directly — the project page detects exactly that and says so.

Owner-only, enforced by RLS rather than by the UI: a rate is compensation, and a
viewer holding a project's labour cost and its hours could divide one by the
other to recover a salary.

| | Your part |
|---|---|
| 🟡 | **Add AHN's people with their loaded cost** — salary plus employer taxes and benefits, not the headline salary. An unloaded figure understates a real employee by roughly a fifth and every project they touch inherits the error. |
| 🟡 | **Decide the working-hours-a-year figure.** Defaults to 1,880 (full-time after leave). 2,080 assumes nobody takes any. It sets every salaried hourly rate. |
| ⚪ | **Log time, or allocate it.** Hours are the unit either way: "Jane spent 40% of August on this" is 0.4 × her month. |

---

## Phase 2 — built: growth & margin simulator (spec §11)

**Built.** `/simulator` answers two questions: what a monthly growth rate
compounds to, and what revenue a target margin would require. Base, conservative
and aggressive scenarios are derived from the month-over-month growth AHN has
actually had — not from invented round numbers. See decisions 58–60.

Nothing is saved. It is a calculator, not a record: a stored projection acquires
the authority of history a quarter later.

| | What the current data says |
|---|---|
| 🟡 | **Monthly revenue varies ±111% around its own average.** The page says so — there is no typical month to compound from yet, and every figure should be read as an order of magnitude until there is more history. |
| 🟡 | **Only 3 months of growth to read**, so the preset scenarios are marked indicative and the page opens on the custom rate. Six months makes them meaningful. |

| | Remaining engineering |
|---|---|
| ⚪ | **Gross vs. net margin targets** — done, see decision 93. The note that said the §7 taxonomy lacked a cost-of-delivery classification was simply wrong: it has had one all along. |
| ⚪ | **Saved scenarios**, deliberately not built — see above. If AHN wants to compare plans over time it needs a decision about how a stored projection is labelled so nobody reads it as an actual. |

---

## Phase 2 — built: budget vs. actual (spec §19)

**Built.** `/budgets` measures spending against a plan at any of six levels —
everything the company spends, a category, a business unit, a client, a project
or a legal entity — over a month, quarter or year. Every figure drills to the
payments behind it. See decisions 72-74.

**Overspend alerts fire before the overspend**, on the projection, once per
budget per period, and again once if it actually goes over. They will not fire
on a projection the maths cannot support.

| | Your part |
|---|---|
| 🟡 | **Set AHN's budgets.** Nothing exists yet - the test budgets used to verify the feature were deleted afterwards. Start with the categories that matter: payroll runs at $5,850/mo and recurring charges at $8,049/mo. |
| ⚪ | **Tune the alert threshold** on `/alerts`. It fires when the projection reaches 100% of budget; raise it to 1.1 to hear only about a projected 10% overrun. |

| | Remaining engineering |
|---|---|
| ⚪ | **Editing a budget amount** in place. Saving the same scope and period again replaces it, which works but is not obvious. |
| ⚪ | **Department-level budgets** (§19 names "department"). Business unit is the closest thing that exists; a separate department dimension needs its own table. |

---

## Phase 2 — built: receivables and payables (spec §17, §18)

**Built.** `/obligations` records money that is going to move but has not —
invoices out, and bills and commitments in. Aging buckets, contracted vs
invoiced, and the figure the feature exists for: **cash after commitments**.
See decisions 75-77.

Receivables are shown and deliberately left out of that headline. A bill is a
promise AHN has to keep; an invoice is a promise somebody else made to it.

**Alerts:** overdue invoices (keyed by aging bucket, so 30-to-60 days is news
and the days between are not) and large commitments inside a fortnight.

| | Your part |
|---|---|
| 🟡 | **Record AHN's real commitments.** Payroll, VEEM runs, contractor invoices, legal retainers, accounting fees, taxes, software renewals, venue deposits — §18 names them all. Until they are recorded, the cash figure on every other page counts money that is already spent. |
| 🟡 | **Record outstanding client invoices**, with what was contracted where it differs from what has been billed. |
| ⚪ | **Tune the alert floors** on `/alerts`. Overdue invoices fire above $100; upcoming commitments above $1,000 inside 14 days. |

| | Remaining engineering |
|---|---|
| ⚪ | **Generating recurring obligations** — done, see decision 92. Set a cadence on a commitment and the daily job fills ninety days ahead. Rows created before this carry `is_recurring` with no cadence: they generate nothing until somebody sets one, deliberately. |

---

## Phase 3 — built: the seven roles (spec §23)

**Built.** Owner, CFO, accountant, department lead, project manager, employee
and read-only viewer, enforced by Postgres rather than by the interface. See
decisions 78-80.

|  | sees compensation | sees all money | moves money | categorises | integrations | people | projects | audit |
|---|---|---|---|---|---|---|---|---|
| Owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| CFO | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Accountant | ✓ | ✓ | | ✓ | | | | ✓ |
| Department lead | | | | | | | own unit | |
| Project manager | | | | | | | | |
| Employee | | | | | | | | |
| Viewer | | ✓ | | | | | | |

Department leads, project managers and employees are **scoped**: they see their
own unit, their own projects, or their own record — deliberately less than a
viewer, who is trusted with the whole picture minus compensation.

| | Your part |
|---|---|
| 🟡 | **Assign real roles.** Only `pinlo752004@gmail.com` (owner) and the RLS test viewer exist. Create a login with `node scripts/create-user.mjs <email> <password> <role>`, then change roles on **/access** afterwards. |
| 🟡 | **Set `owner_user_id` on projects and `lead_user_id` on business units.** Scoping depends on them: a project owned by nobody is invisible to every scoped role, and a unit with no lead has none. |

| | Remaining engineering |
|---|---|

---

## Phase 2 / Phase 3, not started

The *interpretation* half of the AI CFO layer (§20) · Google Workspace billing
and automated SaaS vendor tracking.

§20's deterministic half is built and live at `/explain` — where the cash went,
who moved, and which payments are unusual for the vendor that charged them, all
arithmetic. What is missing is the model that reads it and writes the sentence.
Plan §11 gates that on "2-3 months of clean data"; the ledger holds 135 sandbox
transactions, so the blocker is the input, not the work. It becomes worth
building once AHN's real bank and VEEM history is imported and the uncategorised
26% above is cleared — the same two items already on your checklist.

The schema is shaped so these attach without a rebuild: `is_subscription` and
`is_recurring` are populated on every transaction, categories follow the spec §7
taxonomy, and counterparties are already normalised and deduplicated.
