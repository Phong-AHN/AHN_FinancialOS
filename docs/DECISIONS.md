# Engineering decisions

Where the implementation departs from — or sharpens — the MVP plan, and why.
Each one is a judgment call worth reviewing rather than a detail buried in a diff.

---

## 1. Eleven tables, not ten: `exchange_rates` was added

**Plan §4:** "10 tables, no more."

**What was built:** 11. The extra one is `exchange_rates`.

**Why:** AHN holds USD accounts and a VND account. The Definition of Done requires
"total cash on hand … rolling up to one correct number." That number cannot exist
without a rate, and hard-coding one in the app would make every historical report
silently change the day the rate moved. Spec §27 lists currencies/exchange rates as
a core entity, and §3 requires multi-currency reporting across USD and VND.

Rates are stored **dated**, and lookups take the most recent rate at or before the
reporting date, so a report re-run next month for the same period produces the same
figure.

**Deliberate safety choice:** a currency with **no** rate on file is valued at **zero**
in the USD total, not treated 1:1. Treating 1 VND as 1 USD would overstate cash
roughly 26,000×. Understating is visible and recoverable — the Accounts page raises a
"missing exchange rate" banner naming the currency. A 26,000× overstatement in a
runway number is not recoverable; someone acts on it.

---

## 2. QuickBooks Invoices and Bills are not synced into `transactions`

**Plan Day 2:** "Sync Deposits, Purchases, Bills, Invoices via the API."

**What was built:** Purchase, Deposit, Payment and BillPayment — the cash-affecting
entities. Invoices and Bills are not written to `transactions`.

**Why:** Invoices and bills are **accruals**, not cash. An invoice and the customer
payment that settles it are the same dollar arriving twice in the ledger. Booking
both into one `transactions` table would double-count revenue — directly violating
the criterion the spec calls non-negotiable (§28: "No transaction is double-counted").
It would also corrupt every number built on top: cash, burn, runway, break-even.

`BillPayment` **is** included and `Bill` is not, for the same reason: the payment is
the cash event.

**Where they belong:** the Accounts Receivable and Accounts Payable modules (spec
§17–18), which need their own tables with aging buckets, due dates and paid/unpaid
state. Those are Phase 2. Nothing about this decision blocks them — it keeps the cash
ledger clean until they arrive.

**If you disagree:** the fix is one array in
[`connectors/quickbooks.ts`](../src/lib/connectors/quickbooks.ts) (`CASH_ENTITIES`),
but the cash and runway figures stop being trustworthy the moment it changes.

---

## 3. Suspected duplicates are held *out* of cash, and the amount withheld is shown

**Plan Day 3 / DoD item 7:** "Flag matching transactions … as 'possible duplicate'
instead of double-counting them in total cash."

**What was built:** exactly that — plus the total held out is displayed on the CEO
home screen and the Accounts page, linking to the reconcile queue.

**Why the addition:** the plan's rule is a heuristic (amount + direction + date
window), so it will sometimes flag a pair that is genuinely two separate payments.
Excluding is the right default — overstating cash is the more dangerous error — but
silently excluding means the dashboard is quietly short by an unknown amount. Showing
the withheld figure keeps the number honest and gives the reviewer a reason to clear
the queue.

Rows are never deleted. Spec §28 requires every imported dollar to stay traceable,
including the ones we decided not to count.

---

## 4. QuickBooks wins ties in the deduplicator

When the same activity arrives from both QuickBooks and Plaid, the QuickBooks row
survives in the totals and the bank-feed copy is flagged. Spec §29 makes QuickBooks
the accounting source of truth; this is that principle applied where it actually
bites. Ranking lives in `SOURCE_RANK` in [`dedup.ts`](../src/lib/dedup.ts).

---

## 5. One alert per transaction, not one per matching rule

A USD 8,000 payroll run matches both "money out — any amount" (Slack + email, info)
and "unusually large outflow" (Slack + email + SMS, warning). Firing both rules
independently would send the CEO the same payment twice on Slack and twice by email.

The engine instead composes **one** alert carrying the highest severity and the union
of the channels: one Slack message, one email, one SMS. See `selectAlertPlan` in
[`alerts/engine.ts`](../src/lib/alerts/engine.ts).

---

## 6. `alerted_at` is stamped even when delivery fails

Otherwise a Slack outage turns into the same 400 alerts replaying on every cron tick
once it recovers. Failed deliveries stay visible as `failed` rows in the notification
log with the provider's error, which is where a delivery problem should surface —
not in the CEO's phone at 3am.

---

## 7. Two filters, kept rigorously distinct

The single easiest way to get a dashboard like this quietly wrong:

- **`countsTowardCash`** — excludes duplicates, **keeps** internal transfers. Moving
  money between our own accounts really does change each account's balance.
- **`countsTowardPnl`** — excludes duplicates **and** internal transfers. Moving your
  own money is neither revenue nor expense.

A Stripe payout appears on both sides (out of the Stripe balance, into the bank). If
transfers counted toward P&L, AHN's monthly burn would inflate by the entire payout
volume and runway would collapse for no real reason. Both are covered by tests in
[`tests/calc.test.ts`](../tests/calc.test.ts).

---

## 8. Burn excludes the current partial month

`lastCompleteMonths()` deliberately ends at the last day of the previous month. On
the 3rd, the current month holds three days of spend; averaging that in would
understate burn by roughly 90% and inflate runway by the same factor — in the
flattering direction, which is the worst kind of wrong for a runway number.

---

## 9. Rounding: `toPrecision(15)` before the money round

`toMinor()` scales by a power of ten, which reintroduces exactly the floating-point
error the minor-unit design exists to avoid: `19.99 * 100` is `1998.9999999999998`
and `1.005 * 100` is `100.49999999999999`. A plain `Math.round` books 19.99 correctly
but turns 1.005 into 1.00. Rounding to 15 significant digits first snaps the value
back to the decimal the source meant. Covered by `tests/money.test.ts`.

---

## 10. Vietnamese header matching is anchored, not prefixed

The VN bank terms for debit and credit are "Ghi Nợ" and "Ghi Có". Matching bare `no`
and `co` as prefixes causes `no` to match **"Nội dung"** (the description column),
which maps description as debit and imports an entire statement as zeros. The
patterns require the full Vietnamese phrase, or `no`/`co` as a complete header.

This is the kind of failure that produces a clean-looking import of a wrong number,
which is why the import UI also shows a parsed preview with totals before writing
anything.

---

## 11. Pending Plaid transactions are skipped

A pending charge changes amount or disappears before it posts. Alerting the CEO about
a dollar that never actually left the account costs more trust than alerting a day
later costs speed.

---

## 12. Stripe is read via `balance_transactions`, and fees are booked separately

Syncing `/v1/charges` shows gross revenue and hides processing fees, overstating what
reached the bank. `balance_transactions` mirrors the actual Stripe balance, and the
connector splits each fee onto its own expense line so software/processing cost stays
visible per spec §7. Payouts are marked as internal transfers.

---

## 13. Only interpretive fields are editable

The transaction edit API accepts category, subcategory, notes, the recurring and
transfer flags, and reconciliation status. It refuses amount, date, direction, account
and the source key.

Those five are what the bank or the ledger actually reported. Editing them would break
the promise that every dollar traces back to its source (§28). A wrong amount is a
source problem — fix it in QuickBooks, or re-import.

---

## 14. `audit_logs` has no update or delete policy for any role

Not even the owner. A financial edit trail that can be rewritten after the fact is
not an audit trail. Insert and select only — see
[`0002_rls.sql`](../supabase/migrations/0002_rls.sql).

---

## 15. Cron routes refuse to run without `CRON_SECRET`

Rather than defaulting to open. An unauthenticated endpoint that hammers the
QuickBooks API and pages the CEO is not an acceptable default for a missing
environment variable.

---

## 16. Every server-side Supabase read disables the Next.js fetch cache

**Found in testing, not in review.** The duplicate sweep reported flagging two
rows while the database showed none, and the ids it named did not exist in the
table at all.

Cause: the Next.js App Router replaces the global `fetch` and caches GET
requests by default. `supabase-js` issues a GET for every `.select()`, so a
server-side read was being answered from a previous request's response body —
rows that had since been deleted. `export const dynamic = 'force-dynamic'` does
**not** prevent this; it governs route rendering, not the fetch layer beneath it.

On a financial dashboard this is a correctness bug, not a performance one: the
CEO can be shown an earlier request's cash figure, an alert can quote a stale
balance, and — as observed — the dedup sweep can operate on transactions that no
longer exist while cash stays double-counted.

Every Supabase client is now built with a `fetch` that passes `cache: 'no-store'`
([`no-store-fetch.ts`](../src/lib/supabase/no-store-fetch.ts)). The database is
the source of truth by design, and the data volume is small.

---

## 17. The duplicate sweep runs every tick, not only after an integration syncs

It used to run only inside `ingestTransactions`. A company with no integrations
connected — which is every company on day one, and any company importing only
CSVs — would therefore never have the sweep run at all, and every duplicate pair
would double-count cash silently.

It now runs unconditionally in `/api/cron/sync` and `/api/sync`.

---

## 18. The sweep window matches the initial backfill depth, not the posting gap

A bank posting and its QuickBooks twin are only days apart, which argues for a
short window. But the **first** sync of any source backfills six months at once,
and every duplicate pair inside that backfill is dated older than a short window
would ever reach — so those pairs would double-count permanently, with nothing
to trigger a re-check.

`DEDUP_WINDOW_DAYS` is therefore 180, matching `INITIAL_LOOKBACK_DAYS`. The scan
buckets by exact amount first, so it stays near-linear rather than pairwise.

---

## 19. The sweep counts rows it actually changed

The original code treated "no error" as success. A Supabase `.update()` that
matches zero rows returns no error, so the sweep reported work it had not done —
which is precisely what hid decision 16 for as long as it did. It now uses
`.select()` and counts returned rows.

It also separates **`alreadySettled`** from **`errors`**: a sweep every ten
minutes will re-find every pair it has already flagged, and reporting those as
failures forever would bury a real failure in noise.

---

## 20. Plaid's Development environment no longer exists — Day 3's premise has changed

**Plan §1 states:** "Plaid's 'Development' environment lets you connect up to 100
real bank accounts right away, no Production approval wait. Plenty for an MVP." It
is listed as ✅ Real API, with no blocker.

**Verified against Plaid directly:**

```
sandbox      HTTP 400  INVALID_FIELD     (host live, credentials rejected — expected)
development  UNREACHABLE: ENOTFOUND      (host does not resolve)
production   HTTP 400  INVALID_FIELD     (host live)
```

`development.plaid.com` has been retired. Only `sandbox` and `production` remain.

**What this changes.** Reaching AHN's real US bank accounts now requires Plaid
**Production** access — an application with a review, not a self-serve toggle. That
puts US banking in the same category the plan already assigned to VN banks and VEEM:
blocked on a third party outside the builder's control.

**What still works today.** `sandbox` connects simulated banks immediately (sign in
at the bank prompt with `user_good` / `pass_good`) and exercises the entire pipeline
end to end — Link, token exchange, `/transactions/sync`, ingest, categorisation, USD
stamping, dedup, alerting. Everything except the money being real.

**Handled in code**, since silence here is expensive: `PLAID_ENV` accepts only
`sandbox` or `production`; `development` is rejected with an explanation rather than
producing a bare DNS error; an unusable value falls back to **sandbox, never
production**, so an unclear config cannot be the reason a live banking call goes out.
The Integrations page states plainly when Plaid is on simulated data.

The same treatment covers Stripe: the page distinguishes an `sk_live_` key from an
`sk_test_` one, because a test key returns a plausible balance and a full history
that is entirely fabricated — and nothing about the resulting dashboard would look
wrong.

---

## 21. The cash trend line only counts accounts that are part of cash

`computeCashTrend` reconstructed history from **every** non-duplicate
transaction, including the 118 credit-card rows on an account explicitly
excluded from cash. The headline tile was right; the chart under it drew a past
that never happened, and only the final point — anchored on today's real cash —
agreed with it.

Fixed by passing the accounts in and filtering to those that are active and
`include_in_cash`. Three tests cover it.

---

## 22. Notifications outlive the transaction they announced

`notifications.transaction_id` was `ON DELETE CASCADE`. Deleting a transaction
therefore erased the record that someone had been paged about it — including
when the Plaid sync deletes a bank-reversed transaction, which it does routinely.
The alert log would then disagree with what people actually received.

Migration `0004` changes it to `ON DELETE SET NULL` and adds a `context` snapshot
so the row stays readable without its transaction.

**Demonstrated live during the Day-4 test**: the end-to-end run produced eight
notification rows, the cleanup deleted the two test transactions, and all eight
notifications vanished with them. That is the bug, reproduced.

---

## 23. The alert insert degrades rather than failing when a migration lags

The `context` column arrives with `0004`. A deploy can outrun a migration, and
here the cost of that is total: every notification insert fails, so no alert is
recorded **or delivered**.

So the insert retries in the pre-0004 shape when the column is missing, and notes
that the migration is outstanding. Alerting survives on an older schema; the only
thing lost is the snapshot. This is why the Day-4 test still delivered on a
database where `0004` had not been applied.

---

## 24. The end-to-end test writes a real transaction, and quarantines it

MVP Plan Day 4 asks for "create a test transaction → receive the alert within
seconds", and Day 7 repeats it in front of the CEO. Writing invented money into a
live ledger is normally a bad trade, so three things contain it:

1. an account with `is_active = false` and `include_in_cash = false` —
   `computeCashPosition` filters inactive accounts outright, so cash, balances
   and the trend cannot see it;
2. `is_internal_transfer = true`, so `countsTowardPnl` excludes it from revenue,
   expense, burn, runway and break-even;
3. a description and counterparty that say it is a test.

The row is **kept**, not deleted. Its transaction page shows which channels fired
— that page *is* the Day-7 demo — and deleting it would leave the notification
log pointing at nothing, which is the shape of the stale-id bug that cost real
debugging time earlier in this build.

---

## 25. Runway never headlines infinity for a company that spends real money

Net runway is `cash / (spend - revenue)`. When revenue happens to cover spend,
that denominator is zero and the honest mathematical answer is infinite.

The dashboard was printing **"Runway: ∞"** and **"On $0.00/mo net burn"** for a
company spending **$90,619 a month** with **3.6 months of cash** — and, at the
worst month on record, **2.8 months**. It is the most flattering possible way to
be wrong: a company one lost client from trouble reads its own dashboard as
untroubled.

`Runway` now carries four figures, and `headlineMonths` picks the one to show:

| | |
|---|---|
| `grossMonths` | cash / gross burn — how long the money lasts if revenue stopped |
| `netMonths` | cash / net burn — null while cash-positive |
| `worstCaseMonths` | cash / the worst single month of outflow (spec §9 downside) |
| `headlineMonths` | net while burning, **gross while cash-positive** |

Every readout was switched to the headline figure — the tile, its colour, the
"needs attention" list, the low-runway threshold alert, the Slack alert body and
the digest. Each of those was independently reporting ∞.

"Needs attention" now says: *"Cash covers only 3.6 months if revenue stopped —
below the 6-month floor, despite being cash-positive."* It previously said
nothing at all.

---

## 26. The ledger's own categories were being thrown away

QuickBooks returns the chart-of-accounts name on every expense line —
`Automobile:Fuel`, `Legal & Professional Fees:Lawyer`, `Meals and Entertainment`,
`Office Expenses`. The connector stored it in `subcategory` and then left
`category` as `uncategorized`, so the home screen reported *"47 transactions have
no category"* while the accounting source of truth (spec §29) had already
classified them.

`categorize()` now takes the ledger account and weighs it FIRST, ahead of the
bank memo — which for these rows reads `Purchase 144` and carries nothing at all.
Six chart-of-accounts rules were added. On the live data this categorised 32 of
47 rows.

The remaining 15 are genuinely unclassifiable and stay in the queue: QuickBooks
`BillPayment` entities carry no expense account (it lives on the Bill they
settle, which is deliberately not synced — see decision 2), and "Rock Fountain"
tells nobody anything.

Rules only run at ingest, so `/api/transactions/recategorize` re-runs them over
rows still marked uncategorised. It **never** touches a row with an audit-log
entry on `category`: a rule does not outrank a person.

---

## 27. Two regex word-boundary bugs, one of them invisible

A word-boundary escape wrapped around `(marketing|advertis|...)` can never
match **"Advertising"** - the trailing boundary falls between `s` and `i`,
both word characters, so that alternative is rejected and nothing else in the
group fits. Same trap as the Vietnamese `Ghi No` headers in decision 10. The
alternative is now `advertis` followed by a trailing-word matcher.

The second was worse. Six new rules matched nothing despite looking correct in
every editor. `cat -A` showed why: a literal **backspace character (0x08)** sat
between the boundary escape and the opening bracket, so every one of those
patterns demanded a backspace character in the input. A scripted edit had
written the escape as a single control character rather than as the two
characters. Twelve of them across the file - invisible to `grep`, invisible to
`tsc`, invisible to review.

Worth remembering as a class: a regex that silently matches nothing is
indistinguishable from a rule that simply never applies, and no type system or
test-free eyeball catches it. Only running the rule against real input does.

---

## 28. Slack rejoins a channel itself, when it can

An alert that discovers the bot has been removed from a channel is the alert
that gets lost. With the `channels:join` scope the app can put itself back and
deliver it, so `sendSlack` retries once after a successful `conversations.join`.

It only fires when the channel is configured as an **ID**. `conversations.join`
accepts an ID and nothing else — passing `#ahn-finance-alerts` returns
`channel_not_found`, verified against the live workspace — and turning a name
into an ID needs `channels:read`, which is a separate grant this token does not
carry. Rather than pretend otherwise, the `not_in_channel` message now names
both fixes: `/invite @ahn_financialos`, or configure the channel as an ID so the
app can heal itself.

Worth recording about the environment: this workspace's bot holds
`chat:write`, `channels:join`, `channels:history`, `commands` and
`incoming-webhook`. Notably absent is `channels:read`, which is why
`conversations.list` returns `missing_scope` and channel membership cannot be
audited from the app.

---

## 29. Supabase's direct database host is unreachable on IPv4 — and the fix was derivable

`db.<ref>.supabase.co` publishes **only an AAAA record**. This machine has just a
link-local `fe80::` address and no IPv6 route — `ENETUNREACH` even to public DNS
over v6 — so `npm run db:push` failed and migration `0004` sat unapplied.

The mistake worth recording is mine: I reported the host as unreachable and
handed the problem back, when everything needed to solve it was already in
`SUPABASE_DB_URL`. The pooler is reachable over IPv4 and takes the **same
password**, with the user rewritten to `postgres.<ref>`; only the region was
unknown, and there are about a dozen candidates. Probing them found
`aws-0-ap-northeast-1` in seconds.

`db-push.mjs` now does that automatically: on `ENOTFOUND`/`ENETUNREACH` against a
`db.*` host it derives the pooler URL, probes the regions, runs the migrations
through the one that answers, and prints the URL to save. A tool that can work
out the answer should not ask the operator for it.

Only `db:push` is affected. The app and `db:seed` reach Supabase over HTTPS,
which resolves to IPv4 normally.

---

## 30. A drill-down that contradicts its tile is worse than no link

Two problems, both silent.

**The month-to-date tiles linked to the wrong window.** The tile VALUE is
computed through today; the link carried `to=<end of month>`. They agree only
while nothing is dated later this month — and QuickBooks emits future-dated rows
routinely, a scheduled bill or a post-dated deposit. The moment one exists,
"Revenue received (MTD)" shows one figure and its own drill-down shows a larger
one. All five links now end at today.

**The drill-down totalled only the page on screen.** Click "Spent MTD $64,186",
land on 100 of 137 rows, read a smaller total. It was labelled "(this page)", so
it was not lying — but the Day 6 deliverable is that a number drills down to the
transactions that produced it, and a partial total confirms nothing.
`loadTransactionTotals` now sums every matching row (three columns, capped at
20,000) and the page states the coverage plainly.

Both filter paths share one `applyFilters` helper, so the rows shown and the
total displayed can never be computed over different sets.

Verified against live data: tile `$64,186.43` → linked page
`Money out −$64,186.43, all 37 matching rows`.

---

## 31. The source system is a categorisation signal, and was being ignored

A VEEM export names the recipient and nothing else. "Jomar Reyes" says nothing
about what the payment was for, so every row of a VEEM import landed in
`uncategorized` — even though the file being a VEEM export establishes it is
Philippines payroll with a certainty no description could match. Same for a
payroll export.

`categorize()` now takes `sourceSystem`, and the two single-purpose rails
(`csv_veem`, `csv_payroll`) settle the category before any pattern runs.
Outflows only: money *arriving* on a payroll rail is a refund or a top-up, not a
wage.

General-purpose sources are deliberately excluded. A bank feed carries every
kind of spend, so `plaid` or `csv_vn_bank` tells you nothing and the patterns
still decide.

Found by running the sample imports end to end — not by reading the code.

---

## 32. Precision about "append-only" audit logs

Decision 14 says a financial edit trail cannot be altered or removed. That is
true **through the app**: `audit_logs` has an insert policy and no update or
delete policy, so no signed-in user — owner included — can change it.

The service-role key bypasses RLS entirely and can. That is inherent to that
key, not a gap in the policy: it is the system account the sync and alert jobs
run as, and anyone holding it can already write any number they like into
`transactions`. The protection is real for users and the key is the thing to
guard.

---

## 33. Where payroll lives in QuickBooks depends on the company

AHN runs payroll through QuickBooks rather than a separate export, so the
question is which QuickBooks entity holds it. There is no single answer:

- a company on **QuickBooks Payroll** posts each pay run as a `JournalEntry`
  against wage and tax expense accounts;
- a company paying through a **bureau** books it as a `Purchase` or
  `BillPayment` — both already synced;
- a company **not running payroll in QuickBooks** has neither.

The connected sandbox is the third kind. Its inventory: 2 employees, 5
timesheets, 48 expense accounts of which exactly one is compensation-adjacent
("Workers Compensation", subtype Insurance) — **no wage or salary account, and
no payroll transactions**. Its three journal entries are all opening balances
(`Notes Payable / Opening Balance Equity`), carrying no cash movement at all.

So booking journal entries would have invented $42,495 of spend that never left
a bank account. They stay unsynced, consistent with decision 2.

`tests/qbo-inventory.integration.test.ts` reports this for any connected
company. Run it against AHN's **production** books before deciding whether the
connector needs extending — the answer is a property of their chart of accounts,
not something to guess at.

---

## 34. Real and demo transactions were indistinguishable in the UI

The database held 66 real QuickBooks rows among 379 from `npm run db:seed`, and
nothing in the interface could separate them. Asked "where is the real
QuickBooks data?", the honest answer was: mixed into everything, unfindable.

Two filters close it. **Source** narrows to one connector. **Real money only**
hides rows keyed `demo-%`, the convention the seeder writes — the one reliable
marker of fabricated data.

The Integrations page now also counts **real** rows per provider and links
straight to them. Counting demo rows there would have been worse than useless:
it would report an integration as working when it had never synced anything.

---

## 35. An unquoted `#` in `.env.local` silently disabled Slack channel routing

`SLACK_DEFAULT_CHANNEL=#ahn-finance-alerts` looks correct and is not. dotenv —
which is what Next.js parses `.env.local` with — treats an unquoted `#` as the
start of a comment, so the value arrives **empty**.

`sendSlack` prefers the bot token only when it has both a token and a channel.
With the channel empty it fell through to the incoming webhook. The consequences
were all invisible:

- every alert went to the webhook's single channel, so per-severity routing
  (`#ahn-finance-critical`, `#ahn-finance-warnings`) never happened;
- webhook messages carry a **different bot identity**, so `chat.delete` returns
  `cant_delete_message` — the app cannot clean up after itself;
- nothing errored, and the delivery log said `sent`.

Quoting the four values fixes it. `.env.example` now says so where the mistake
gets made.

**Why the tests did not catch it.** `tests/setup-env.ts` used a looser regex than
dotenv, so the suite saw a channel where the app saw an empty string, and
reported routing as working. A harness that reads configuration differently from
the application is not testing the application. It now follows dotenv's rules,
and `tests/env-parsing.test.ts` locks them — including the `KEY=#value` case
directly.

---

## 36. The alert engine had no age horizon, so a first sync was a flood

Found by running it: syncing an already-populated QuickBooks company fired
**68 Slack messages in one burst**, 66 of them about transactions dated back to
March.

The engine alerted on every row with `alerted_at is null`, regardless of age.
The first sync of any source backfills roughly 180 days, so a real first connect
would page the CEO hundreds of times about money that moved months ago — at the
exact moment the alert channel is meant to earn trust.

`ALERT_MAX_AGE_DAYS` (default 3) now bounds it. Older rows are still ingested,
still counted in every total, still visible; they are marked as seen rather than
announced, and the count comes back as `suppressedAsBackfill` so the suppression
is visible rather than silent. An explicit id list — the end-to-end test, a
manual replay — bypasses the horizon, because somebody asked for those rows
specifically.

Verified by clearing `alerted_at` on all 66 rows and re-running:
**65 suppressed, 1 alerted, 1 Slack message** instead of 68.

The seeder had guarded against this since day one. The production path had not,
which is the sort of gap that only shows up when you run the thing.

---

## 37. A mortgage was being counted as cash

Connecting a Plaid sandbox bank added **$182,228 of debt and locked-up holdings**
to the figure that answers "how much cash do we have?" — a $56k mortgage, a $65k
student loan, a $23k auto loan, a $13k HELOC, a 401k and an IRA.

Plaid returns six account types: `depository`, `credit`, `loan`, `investment`,
`brokerage`, `other`. `mapAccountType` handled the first two and sent everything
else to `other`, which counted as cash.

Loans made it worse than an omission. Plaid reports the balance **owed** as a
**positive** number, so borrowing more raised the cash figure. A CEO reading the
home screen would have seen a quarter of a million dollars of headroom that did
not exist.

Now: loans and investments carry their own account type, never count as cash,
and loan balances are negated to read as the liabilities they are. An
**unrecognised** type is also not cash — overstating what a company can spend is
the dangerous direction, and a balance wrongly left out is visible on the
Accounts page where a person can turn it back on.

Cash went from ~$246,818 to **$64,590**, with $139,911 correctly excluded.

Migration `0005` adds the enum values and `0006` reclassifies rows already
imported. They are separate files because Postgres refuses to *use* an enum
value in the same transaction that *added* it, and the migration runner sends
each file as one statement.

---

## 38. The schedule moved off Vercel Cron, not off Vercel

Vercel's Hobby plan allows one cron run per day. The sync needs ten-minute
intervals for "every dollar, within a few minutes" to mean anything, so
the schedule moved to `worker/index.mjs`, deployed separately.

**Nothing about the app changed.** The `/api/cron/*` endpoints are identical,
still guarded by `CRON_SECRET`; the worker is only a caller.

`vercel.json` was then deleted outright. With the crons gone it held nothing, and
an attempt to leave the reasoning behind as a `comment` key failed schema
validation — Vercel rejects unknown properties, and JSON has no comments. The
restore instructions live in [DEPLOYMENT.md](DEPLOYMENT.md), which can say it in
prose. Nothing was lost: `maxDuration` is declared per route via
`export const maxDuration`, and the headers are in `next.config.mjs`.

**A loop, not the host's cron.** Railway has its own cron feature, and using it
would have tied the schedule to one provider's syntax, quotas and minimum
interval. A plain interval loop runs identically on Railway, Render, Fly or a
VPS, which matters more than the small cost of an always-on process.

Three details worth keeping:

- **Digests check the wall clock, not an interval.** An interval-based daily
  digest drifts every redeploy. The loop wakes each minute, fires on the
  configured hour, and records the day it fired so a restart inside that hour
  cannot send it twice.
- **`/health` answers 503 once any job has failed.** Railway restarts a worker
  that has lost the app instead of leaving it quietly dead — and a scheduler
  failing silently is the whole risk of moving the schedule out of the app.
- **The worker holds no credentials beyond a URL and the shared secret.** No
  database access, no Supabase keys, no provider tokens. Compromising it exposes
  far less than compromising the app.

Verified end to end: correct secret gives `sync ok  0 new` and `/health` 200;
a wrong one gives `sync FAILED  401 {"error":"Unauthorized."}` and `/health` 503.

---

## 39. Railway's dependency scan blocked the deploy, and it was right to

Railway refused to build:

```
next@14.2.15  HIGH
  CVE-2025-55184, CVE-2025-67779
  Upgrade to 14.2.35
```

Upgrading was worth doing on its own terms — a financial dashboard should not run
on a Next.js release with two known HIGH advisories — so the fix was the fix, not
a workaround.

Cleaning up what the audit then exposed took the tree from **9 vulnerabilities
(1 critical, 5 high, 3 moderate) to 1 high**, and removed 283 packages:

| | |
|---|---|
| `next` 14.2.15 → 14.2.35 | the two CVEs that blocked the build |
| `vitest` 2.1.9 → 4.1.11 | cleared the **critical** plus three moderates (vite, esbuild, vite-node). All 164 tests pass unchanged. |
| `postcss` override | next@14.2.x pins postcss to exactly 8.4.31, which has two HIGH advisories. npm's suggested remedy was `next@16` — a major upgrade to dodge a transitive patch. postcss 8.x is semver-stable, so the nested copy is pulled up to the patched release instead. The override must match the direct devDependency exactly or npm refuses it. |
| `eslint`, `eslint-config-next` removed | **Never configured.** No `.eslintrc`, no `eslintConfig`, and the `lint` script pointed at a linter that would have prompted for setup rather than linting. Three HIGH findings came in through `@next/eslint-plugin-next → glob`, for a tool that had produced no value. Removing dead weight beat a major upgrade of something unused. |

### The one that remains

`next` still carries a HIGH: *DoS via Image Optimizer, self-hosted applications*.
There is no fix inside 14.2.x — only Next 15+, whose `searchParams`/`params`
became Promises, which is a real migration on a working app.

Rather than leave it implicit that the advisory does not apply, the optimizer is
now **switched off** in `next.config.mjs` (`images: { unoptimized: true }`). The
app renders no images — every chart is inline SVG — so the endpoint was dead code
carrying an advisory. Disabling it removes the surface rather than relying on
nobody calling it.

`npm audit` still reports it, because audit reads versions and not configuration.

---

## 40. The worker was being blocked by a lockfile it does not use

The scheduler in `worker/` has **zero dependencies** and imports one Node
built-in. Railway nonetheless uploads the whole repository before building from
the Root Directory, so the Next.js `package-lock.json` travelled with it — and
the scanner reads that lockfile. An advisory in a package the worker never loads
was blocking the worker's deploy.

`.railwayignore` now excludes everything but `worker/`. The upload went from
1.1 MB to three files, and the scanner sees only what the service actually runs.

This is scoping, not suppression: the app's own dependencies are still audited
when the app is deployed, and the remaining advisory is documented above.

---

## 41. A viewer could read payroll — the policy existed and did not work

Spec section 23 requires payroll to be restricted. The read policy asked
`is_sensitive_category(category)` against a word list — `payroll`, `salary`,
`wage`, and so on.

But the categoriser files a pay run as:

```
category    = 'people'
subcategory = 'us_payroll'
```

`'people'` matches none of those words, so **every payroll row was readable by
every viewer**. Proven with a real viewer session against the live database:
six of seven policies held, and the one that mattered most did not.

That is the worst shape a security bug takes. The policy was present, enabled,
and read as though it worked. Only querying as an actual viewer — with the anon
key and their token, never the service-role key, which bypasses RLS by design —
showed otherwise.

Migration `0007` fixes two things:

1. **`subcategory` is checked as well as `category`.** The payroll signal lives
   there; a rule that ignores it can only half-work.
2. **The whole `people` category is sensitive**, not only rows whose text
   happens to say "payroll". It holds salaries, contractor payments, commissions
   and bonuses — all restricted under section 23 — and an exact category match
   cannot drift the way a word list does.

`tests/rls.integration.test.ts` now runs the same eight checks on demand
(`RLS_TEST=1`), including one that confirms the owner *can* see the row the
viewer cannot — otherwise every other assertion could pass for the wrong reason.

## 42. A subscription is a price, not just a rhythm

The first live run of the section 8 detector found 16 recurring charges, and
reading the list rather than the pass/fail found three things wrong with it.

**Internal transfers were being sold as subscriptions.** `AUTOMATIC PAYMENT -
THANK` at $2,078.50/mo, `CD DEPOSIT .INITIAL.` at $1,000/mo and `CREDIT CARD
3333 PAYMENT` at $25/mo added up to $3,103 of an $11,152 monthly recurring
headline — 28% of the number, and every dollar of it moving between AHN's own
accounts. Worse, the card's own charges were already counted, so the settlement
was double counting spend that appeared elsewhere in the same list.

**Vendors had no names.** The detector showed `Purchase 143`, a QuickBooks
fallback memo, where the joined counterparty said `Hicks Hardware`.

**Regular timing was mistaken for a price.** `Bob's Burger Joint` appeared as a
weekly subscription with a "391% price increase"; `Hicks Hardware` as one with
"-81%". Neither is a subscription. They are vendors used most weeks at whatever
that week's purchase cost — a rhythm with no price behind it, and a "price rose
391%" claim about a vendor that never had a fixed price to raise.

So `scoreAmountStability` was added beside `scoreRegularity`, and confidence is
now the product of the two. The rule doing the work is that **a price point is a
value that REPEATS**: an amount charged exactly once is a purchase, not a price.
A first attempt anchored on the two most recent amounts instead, which quietly
handed every vendor two free perfect scores — with three or four charges that
floor alone cleared the threshold, and the scattered vendors stayed. The unit
test written to pin the behaviour is what caught it.

Live result: 16 charges → 11, and $11,152/mo → $8,049/mo. The three removed were
all things nobody could have cancelled.

## 43. `potentialAnnualSavings` was counting money already not being spent

The summary offered a savings figure built from the lapsed charges. But lapsed
means the vendor has stopped billing — that money is not leaving the account, so
there is no saving left to capture, and the figure sat next to a monthly total
that had already excluded every one of them.

It is now `lapsedAnnualUsdMinor`, and the page labels it "Stopped billing" with
the reason it matters: a charge that stopped is either a cancellation nobody
wrote down, or **a failed payment about to cost you the service**. The second
reading is the one worth acting on, and calling it a saving hides it completely.

The same restraint already applied to duplicates and still does: two tools in
one category might both be needed, so nothing there is counted as a saving
either. The page states plainly what payment data cannot answer — who owns a
tool, whether anyone uses it, what notice cancelling needs.

## 44. Payroll was visible to viewers again, through a word boundary

Decision 41 hid payroll from viewers by category. The subscriptions page then
showed `ACH Electronic CreditGUSTO PAY` at $5,850/mo — and its category was
`uncategorized`, so the policy never applied to it. $5,850 of monthly payroll
was readable by every viewer.

The payroll rule was not missing. `/\b(gusto|adp|deel|rippling|...)\b/i` was
there and correct. The feed had concatenated two fields with no separator, and
there is no word boundary between the `t` of "Credit" and the `G` of "GUSTO", so
the rule never fired. A rule can be right and still never run.

The fix splits on a lower-to-upper transition — but searches the split spelling
**alongside** the original rather than instead of it. Replacing outright broke
`ClickUp` into `Click Up` and lost every CamelCase vendor, which an existing
test caught immediately.

Verified the way decision 41 was: a real viewer session through the anon key
sees **132 of 135** transactions, and its recurring total reads $2,199.04 where
the owner's reads $8,049.04. The $5,850 is absent from the query result, not
hidden in the markup.

The residual risk is worth stating: payroll that no rule recognises stays
`uncategorized`, and uncategorized is not sensitive. Category-based
confidentiality is only ever as good as the categoriser.

## 45. The rule engine had started reading its own handwriting as a verdict

The recategorise pass refuses to overwrite a human correction, which it detects
by looking for an audit-log entry on the row. Broadening that check from "an
entry on `category`" to "any entry" — correct in itself, since someone who fixes
`is_internal_transfer` by hand has ruled on the row — immediately locked the
pass out of every row it had ever touched, because it writes audit entries of
its own. It reported `protected: 9, updated: 0` on rows it had just changed.

Left alone, that would have frozen in every miscategorisation the rules later
learned to fix. `RULE_AUDIT_REASON` is now one exported constant shared by the
writer and the reader, so the two cannot drift apart, and `isAutomatedAudit`
treats anything that is not unmistakably the pass's own prefix as a person's
judgement — protection is the safe default. Proven by running the pass twice:
9 updated then 0 updated, 0 protected both times.

The same investigation found the patch itself was dropping
`is_internal_transfer` — the single field that decides whether a row counts
toward revenue, expense, burn and break-even. That is why the credit-card
settlements above stayed unflagged no matter how many times the pass ran.

## 46. The price-increase alert, and two ways it could have become noise

Spec section 8 finds price rises; until now nothing announced them, so a rise
was visible only to whoever opened `/subscriptions`. A price rise nobody opens a
page to discover is a price rise that simply gets paid.

**It is deduped by event, not by time.** Every other threshold rule uses a
24-hour cooldown. Applied here that would re-announce the same increase every
single day for as long as the vendor kept billing the new amount — the fastest
way to teach someone to ignore a channel. Instead each alert records
`{vendorKey}@{priceChangedOn}` in `notifications.context`, and only entries with
status `sent` count, so a failed delivery is retried rather than silently
swallowed.

**Both floors must clear, not either.** A 40% rise on a $4/mo tool is $19 a
year; a 3% rise on a $70k payroll bill is not a price anyone chose. Either floor
on its own admits one of those. Defaults: 10% AND $50/year.

**It runs on its own daily endpoint, not on the sync tick.** A measured run
varied between 1.8 and 46 seconds — the spread is in write latency, not in any
single request, which the 10-second per-request timeout already bounds. The sync
route already runs four steps under a 60-second ceiling, so stacking this on top
was a timeout that would have taken the ordinary money-in and money-out alerts
down with it. And rescanning three years of ledger every ten minutes to catch a
monthly event is waste regardless.

Two things the work turned up on the way:

- The worker looked up `state.jobs[name]` without a fallback, so a job name with
  no slot would throw inside a timer callback — once a day, in production. Job
  slots are now created on demand.
- `NotificationRow` had no `context` field even though migration 0004 added the
  column and the engine had been writing to it since. Now typed.

## 47. A test that passed without running the code

The first version of the price-increase test was three green assertions over a
feature that had never fired once. The live ledger holds exactly one price rise,
Uber at 17%, and 17% of a $6 fare is $26 a year — correctly below the $50 floor.
Nothing sent, nothing asserted about sending, all green.

The rewrite prints every candidate with the floor that rejected it, and then
lowers the rule's own thresholds to force a real delivery before restoring them
in `afterAll`. That exercises the delivery path *and* proves the two threshold
columns actually control the behaviour — which matters, because the TODO tells
the owner to tune exactly those two numbers.

Result: 2 sent, 1 skipped (email unconfigured), 0 sent on the second run.

The percentage floor is stored as a ratio and shown as a percentage, so the
round trip was verified end to end rather than assumed: typing `15` stores
`0.15`, renders back as `15%`, and writes an audit row. Getting that backwards
would have read `10` as a 1,000% floor and switched the rule off in silence.

## 48. A click cost a second, and almost none of it was the database

Every page took roughly a second to answer. Measured rather than guessed, and
the measurement is the whole story: one round trip from Vietnam to the Supabase
project in Tokyo costs about **145ms**, and an empty `select * from companies`
takes exactly that. The time was distance, not work — so the fix was to make
fewer trips, not faster queries.

Counting the trips before any page data was fetched:

| Where | Call |
|---|---|
| middleware | `auth.getUser()` |
| layout | `getSession()` → `auth.getUser()`, then the `users` row |
| layout | `possible_duplicate` count |
| page | `requireSession()` → `getSession()` **again** → `auth.getUser()`, `users` |

`auth.getUser()` ran **three times per click**, each a real network call to the
Auth server — it validates the token rather than decoding it locally. Four
changes, in order of what they returned:

1. **`getSession()` is memoised per request** with React's `cache()`. The layout
   and the page had been asking the same question twice. Not cached across
   requests: proven by a global sign-out, which is rejected on the very next
   navigation.

2. **The middleware refreshes lazily.** Its job is keeping the cookie alive, not
   authorising anything — every guarded page verifies for itself. It now calls
   `getSession()`, which reads the cookie locally and only goes to the network
   when the token has actually expired. It had been paying 145ms on requests
   whose token had another 59 minutes to live.

3. **Verification and the role lookup run together.** The `users` row is keyed on
   a user id the cookie already carries, so the lookup no longer waits a full
   round trip to be told an id it had. The local read is never trusted: the
   verified id is compared against the claimed one, and a mismatch is treated as
   signed out. A JWT with a rewritten `sub` gets `/login`.

4. **The session check no longer gates the page query.** Every page did
   `await requireSession()` and only then asked for rows. RLS is the real
   boundary and `redirect()` throws before anything renders, so the check
   decides the outcome — it no longer needs to decide the timing.

Result, median over five runs per page:

| | before | after |
|---|---|---|
| `/` | 1094ms | 490ms |
| `/transactions` | 1043ms | 476ms |
| `/accounts` | 997ms | 427ms |
| `/audit` | 807ms | 362ms |
| **all nine pages** | **7606ms** | **3474ms** (−54%) |

Verified afterwards, not assumed: owner reaches all nine pages, signed-out
requests redirect on all nine, a viewer is bounced from all three owner-only
pages, payroll stays invisible to the viewer, and a globally revoked session
stops working immediately.

## 49. The deploy region was about to undo all of it

There was no `vercel.json`, so a deploy would have landed in Vercel's default
`iad1` — Washington DC — while the database sits in `ap-northeast-1`, Tokyo.
Every query would have gone Washington → Tokyo → Washington, with the reader's
own hop from Vietnam to Washington on top. **The app would have been slower
deployed than it is on a laptop in Hanoi**, and no amount of query tuning would
have shown up next to that.

`vercel.json` now pins `hnd1`, beside the database. The shape inverts: the
server-to-database hop drops to single-digit milliseconds and the reader pays
one ~60ms hop for the whole page, however many queries it makes. The Railway
worker needs the same region for the same reason — it calls the app's own cron
endpoints.

The rule worth keeping is that the app and the database share a region. Which
region they share matters far less than that they share one.

## 50. Two page queries were shipping rows across the ocean to count them

`/integrations` pulled up to 20,000 `source_system` values and tallied them in
JavaScript, to render three numbers. It now asks Postgres for three counts, in
parallel, alongside the integrations query that used to run before it. 908ms →
413ms.

The counted sources are typed as the provider keys the cards actually render, so
adding a card without counting it — or counting a source nothing displays — is a
compile error rather than a quietly missing figure.

Three indexes were added for the queries that run most often: `source_system`
for those counts, `(direction, txn_date desc)` for the recurring-charge scan
that reads three years of outflows, and `(alert_rule_id, status)` for the
price-increase dedupe. None of them changes a number anyone can feel at 135
transactions. They are for the ledger AHN will actually have — a sequential scan
over 135 rows and over 200,000 rows look identical right up until they do not.

`loadTransactionTotals` still sums up to 20,000 rows in JavaScript, and was left
alone deliberately. Moving it into SQL means writing the filter logic a second
time, and the entire reason that function exists is that the totals must agree
with the rows on screen. Two implementations of one filter is how they stop
agreeing.

## 51. An event is a project, and building it twice was the mistake to avoid

Spec §12 wants a P&L per client project; §14 wants one per event with its own
revenue and expense categories. §14 opens by saying "treat each event as its own
project", and taking that literally is what kept this small: one `projects`
table with a `kind` column, one P&L function, one page. Two tables would have
meant two implementations of one calculation, and the second would have drifted
the first time somebody fixed a rounding rule in only one of them.

The category taxonomy §14 lists — sponsorships, tickets, venue, production —
is *not* hardcoded. Categories come from the transactions themselves, so an
event shows whatever the ledger actually called things rather than blank rows
for a fixed list nobody used.

The hierarchy in §15 (Company > Business Unit > Service > Client > Project) is
rows, not enums, because §15 requires it to stay admin-editable. The five
business units are seeded with the twelve AHN Labs services the spec names, and
the owner can rename or add to them without a migration.

Clients are a separate table from `counterparties` deliberately. A counterparty
is whoever appears on a bank line — every vendor, bank and refund. A client is
who the work is for. Conflating them would put Slack and the electricity company
in the client dropdown.

## 52. The project P&L reports what it cannot know

Spec §12 lists eleven figures. Four come from the ledger: cash received, direct
expenses, gross profit, margin. Three come from the project row when a person
fills them in: contracted, invoiced, budget. Two cannot be answered at all —
allocated employee labour and allocated software — because they need the time
data in §13, which does not exist yet.

Those two are reported as **absent**, not as zero. A project showing zero
allocated labour reads as "this used nobody's time", which for a services
business is never true, and it would flatter every margin on the page. Both
project pages say out loud that the gross profit shown is an upper bound.

The same rule holds for the human-supplied fields: null is not zero. An
uninvoiced project renders "not recorded", never "$0", because "nobody has told
us" and "nothing is owing" are different answers and only one of them is a
problem.

Three more places the arithmetic refuses to flatter:

- **A margin on zero revenue is null, not infinity.** A project that has spent
  and taken nothing has no margin to state.
- **Internal transfers and flagged duplicates are excluded from both sides**,
  the same filter the company P&L uses. Funding the event account from the
  operating account is not a sponsor.
- **Unassigned money is shown, not hidden.** $32,868 of spending currently
  belongs to no project. Much of that is genuine overhead and should stay that
  way, but a page that omitted it would let the sum of every project P&L
  disagree with the company P&L with nothing on screen to explain the gap.

Attribution is manual and stays manual. A bank line does not say which project
it is for, and a heuristic guess would put real money against the wrong P&L —
the one error in this feature that is worse than a blank.

Verified end to end against live data rather than assumed: a project created
through the API, seven real transactions attributed, and the rendered tiles
checked against the figures computed by hand — $11,874.00 received, $132.50
cost, $11,741.50 gross. An unknown project id is refused rather than written as
a dangling reference, which the `on delete set null` column would otherwise have
accepted silently.

The test project was removed afterwards and all seven attributions reversed. It
was demo data on real transactions, and leaving it would have misstated AHN's
own books.

## 53. Project writes are blocked at the database, not just at the route

Both new API routes check `ownerOnly`. That check is not what makes projects
safe, and testing only the routes would have proved nothing — the same mistake
decision 41 was written about.

So the checks go straight at Postgres with a viewer's own token, the way a
script would: creating a project, rewriting a contract value, deleting a project
and adding a business unit are all refused by policy, while reading a P&L is
allowed, which is the intent — a viewer should be able to see whether the work
made money. Those four checks now live in `tests/rls.integration.test.ts`
alongside the payroll ones, so a future policy change that quietly stops
restricting fails a test instead of going unnoticed.

## 54. Labour cost is an allocation, not a second expense

Spec §13 asks what the work cost. The trap is that payroll has **already left
the bank** — it sits in the ledger as outflows to Gusto and lands in the company
P&L as overhead. Labour computed from time entries is not new spending; it
decides which projects that money was spent on.

So net project profit is `gross profit - allocated labour`, and that is only
correct while payroll transactions stay unattributed. The moment somebody
attributes a Gusto payment to a project *and* logs hours against it, that
project pays for the same people twice and reads far worse than it is, with
nothing on screen to explain why.

No schema can prevent that, so `detectLabourDoubleCount` finds it and the
project page names both figures. Proven live: silent while payroll was
unattributed, and on attributing one Gusto line it reported "$5,850.00 of
payroll attributed as a direct cost, and $9,106.38 of the same people allocated
again from logged hours."

Three smaller decisions that each protect a number:

- **A salaried hour is the loaded annual cost over the hours actually
  available**, not over a hardcoded 2,080. `annual_hours` is a column because
  1,880 (full-time after leave) and 2,080 (none taken) are a company decision.
  Dividing by 2,080 prices every hour about a tenth cheap and quietly improves
  every project that person touches.
- **An unknown rate returns null, never zero.** Zero makes that person's time
  free. Their hours are still counted and reported as `unpricedHours`, and the
  page says the cost figure excludes them — an incomplete number that admits it
  beats a complete-looking one that is wrong.
- **Cost is rounded once at the person's total, not per timesheet line.** A year
  of daily entries at a rate that does not divide evenly drifts by a cent per
  line otherwise.

The database enforces one entry per person per project per day. Without it a
double-clicked form doubles somebody's cost; verified by re-submitting a day and
confirming 20 entries rather than 21.

## 55. Net profit turned a healthy project into a loss, which is the point

The end-to-end run attributed $3,374 of revenue and no direct costs, then logged
120 hours across a salaried employee and a contractor. Gross profit: **+$3,374**.
Net profit once the people were counted: **−$5,732.38**.

That gap is the entire argument for §13. Every project margin before this was an
upper bound, and decision 52 said so out loud — but "upper bound" is abstract
until a project that looks profitable turns out to lose money on the same data.

Variances render beside the actuals: 120 hours against a 100-hour estimate,
$9,106.38 against a $6,000 labour budget. Both targets are nullable and both
render "not set" rather than zero, for the reason decision 52 gives.

## 56. A viewer sees gross, and is told that is what they are seeing

`people` and `time_entries` are owner-only. A rate is compensation, so §23
restricts it — and hours matter one step removed: a viewer holding a project's
labour cost and its hours can divide one by the other and recover a salary the
payroll policy exists to hide.

That creates a trap on the project page. A viewer reads zero hours, and zero
labour subtracted from gross profit renders a **net** profit that is really the
gross one. So the loader distinguishes "nobody logged time" from "you may not
know": RLS answers a viewer with an error rather than an empty list, and on that
error the page shows no net figure at all and says why.

Two more checks now live in `tests/rls.integration.test.ts`, run against real
probe rows so "zero rows returned" cannot pass for the wrong reason.

## 57. The smoke script was checking for content only one data state has

Adding `/projects` to `npm run smoke` passed while a test project existed and
failed the moment it was deleted — the empty state renders neither "Gross
profit" nor "Every project". The check now looks for the page subtitle, which is
there in both states.

Worth recording because the failure mode is subtle: a smoke test that only
passes with data present is a smoke test that will fail on a fresh deployment,
which is exactly when someone most needs it to be trustworthy.

## 58. Scenarios come from AHN's own months, not from round numbers

Spec §11 asks for base, conservative and aggressive cases. Inventing 5/10/20%
would have produced three authoritative-looking numbers with no relationship to
this business — the kind of default nobody questions because it looks
considered.

They are derived from the month-over-month growth AHN has actually had. The
conservative case is additionally floored at zero: if even the weakest quartile
grew, the pessimistic case is *flat*, not "we keep growing at our slowest rate",
which is still optimism wearing a cautious label.

Three refusals in the arithmetic, each one a way a projection starts lying:

- **`expenseGrowthRate` has no default.** A plan that triples revenue on today's
  cost base is not a plan, and a default of zero would make that the easy
  mistake to make by accident. The caller has to choose a number.
- **A margin of 100% or more is refused, not computed.** `revenue = expense /
  (1 - margin)` divides by zero at exactly 1 and *flips sign* above it, handing
  back a negative revenue target that renders as a perfectly plausible figure.
- **Growth from a month with no revenue is skipped, not called infinite.** The
  change from zero is undefined, and an infinity in that list would poison every
  scenario derived from it.

`finalMultiple` is returned alongside the table because compounding is the trap:
+15% a month is not +180% over a year, it is +435%. That number belongs in front
of whoever picked the rate before the rest of the table means anything.

Nothing is persisted. A saved projection acquires the authority of a record, and
a quarter later somebody reads last quarter's guess as history.

## 59. The presets were hostage to one freak month, and reading the output caught it

The first version derived the conservative and aggressive cases from the
weakest and strongest observed months. Against AHN's live data that produced a
**conservative case of −100%** (one month where revenue stopped entirely) and an
**aggressive case of +1278%** (one month with a large contract). Compounded over
a year the second is a number with no meaning; the first says revenue is zero
forever.

The base case had already avoided exactly this by using a median. The outer
cases were simply inconsistent with it. They now use quartiles, which moved the
live figures to −37% and +652%.

**Still not good enough, and more arithmetic could not fix it.** With three
observed growth rates the upper quartile still sits halfway to the maximum, so
one unusual month keeps most of its influence. Quartiles are robust *given
enough points*, and three is not enough.

So `scenarioReliability` says so instead: fewer than six months of observed
growth, or an interquartile range wider than 50 points, makes the presets
indicative rather than meaningful. When they are, the page says why, marks each
preset, and **starts on the custom rate** — landing on a preset built from three
erratic months puts a figure on screen that looks like a recommendation and is
not one.

No test failed to find any of this. It came from reading what the page actually
rendered against real data, which is the third time in this project that has
been the thing that worked.

## 60. The baseline says how solid it is

A steady business and a lumpy one can share an average monthly revenue and mean
completely different things for a plan compounded off it. `revenueVolatility` is
the coefficient of variation — standard deviation over the mean — and above 0.6
the page says plainly that the baseline describes an arithmetic mean rather than
a month that has ever happened.

AHN's current data reads ±111%. The warning is correct and it is showing.

Complete months only. A partial current month would drag the average down for
no reason other than today's date, and every target derived from it would be set
too low.

## 61. Every VND amount with one grouping dot was a thousand times too small

`275.000` in a Vietnamese bank statement is 275,000 dong. The parser read it as
**275**, because one dot followed by three digits is exactly as valid a decimal
point as it is a thousands separator, and the general path chose decimal.

`412.500.000` was fine — two dots, so the existing "more than one dot means
separators" rule caught it. Only amounts with a *single* grouping mark were
wrong, which is the worst version of the bug: the large numbers looked right,
and a 275 next to a 275,000 still reads as a plausible small bank fee.

It was in the sample statement the repo ships as the VN bank template, so it
would have hit AHN's very first real import.

The fix is scoped to currencies with no subunit. A dong cannot have a decimal
part at all, so every dot and comma in a VND amount is a grouping mark — unless
the trailing group is not three digits, which is how `275.00` still reads as 275
rather than being inflated a hundredfold. USD keeps its existing behaviour,
because the same string genuinely means something different in a currency that
has cents.

Found by importing the sample file end to end rather than by any test failing.

## 62. Money from the parent company was being booked as revenue

The same import surfaced a second one. `NHAN TIEN TU CONG TY ME AHN MEDIA LLC` —
money received from the parent company — matched no English transfer term and
fell through to the broad inflow default: **430,000,000 VND booked as revenue**.

Funding the Vietnam entity from the US parent is the single largest inflow a
subsidiary sees. Left alone it would have inflated revenue, break-even, every
project margin and the growth baseline the simulator compounds from. Live effect
on the sample: VN revenue read $23,370 where the true figure is $7,030.

The rules now carry the Vietnamese phrasings, written without diacritics because
VN bank exports are upper-case ASCII and `normalizeName` strips accents anyway:
`cong ty me`, `noi bo`, `chuyen von`, `gop von`, `cap von`, `hoan ung`.

A test pins the other half of it — `KHACH HANG THANH TOAN HOP DONG`, a customer
paying a contract, must stay revenue. Both lines appear in the same statement,
and a rule that swallowed the second would be worse than the bug it fixed.

## 63. The exchange rate could only be changed with a database client

Every dong in the ledger is converted to USD by one number, and until now that
number was reachable only by SQL — the accounts page literally told the reader
to go and edit the `exchange_rates` table. Survivable while every account was
USD; not survivable the moment a VND statement could be imported, because that
one figure drives the cash total, runway and break-even.

`/accounts` now has a rate editor, owner-only and audited like any other
financial control. Three things it does deliberately:

- **Entered as "dong to one dollar", stored as its reciprocal.** That is how
  everyone in Vietnam quotes it and how every published rate reads. The API
  rejects anything ≥ 1,000, which catches the mistake that matters — typing
  26000 into a field that wants 0.000038 would value one dong at twenty-six
  thousand dollars.
- **Dated, never overwritten.** One row per day, so a report re-run for last
  month still uses last month's rate. The seeded rate from the day before is
  still there.
- **Shows every foreign currency held, not only the ones missing a rate.** A
  stale rate converts every balance silently, and nothing else on the page would
  reveal it.

## 64. What the two Vietnamese banks actually offer

Checked rather than assumed, because building a connector against an imagined
API contract is the worst outcome available here.

**VietinBank** runs a genuine self-serve developer portal at
`developer.vietinbank.vn` (iConnect). Register, create an application, receive a
Client ID and Client Secret, and test against a sandbox. Authentication is
OAuth2 with OpenID Connect. Some services still need a branch to enable them.

**Techcombank** has an Open API — reportedly 150+ endpoints including automated
statement extraction — but **no public self-serve sandbox** was found. Access
goes through the bank's business channel, or through an aggregator such as
Finverse or Casso.

No connector was written for either. The exact endpoint contract sits behind
registration, and inventing request and response shapes would produce code that
cannot be tested and looks finished. The work that did not depend on
credentials — making the VND path correct and provable — was done instead, and
it found two real bugs.

## 65. Finverse, and reading the contract instead of guessing it

Neither Vietnamese bank AHN uses can be reached directly today, so the route is
an aggregator. Finverse already covers Techcombank, Vietcombank and VP Bank.

The important part is how the connector was written. The docs site is a
JavaScript application that returns nothing useful to a fetch, and the detailed
API reference sits behind registration — so the source used was
`finversetech/sdk-typescript`, the vendor's own published client: operation
paths from `api.ts`, and the money and account shapes from the response
fixtures in `test/responses`. Every path, field name and type in the connector
traces to a line in that repository.

What that settled, none of which was guessable:

- **`POST /auth/customer/token`** takes `{client_id, client_secret, grant_type}`
  as JSON and returns `{access_token, expires_in}`.
- **Amounts are `{currency, value, raw}`** — decimal major units, *signed*, with
  negative meaning money out. `raw` is the exact figure as a **string**.
- **Account subtypes** are `CURRENT`, `SAVINGS`, `TIME_DEPOSIT`, `CREDIT_CARD`,
  `MORTGAGE`, `PERSONAL_LOAN`, `REVOLVING_LOAN`, `SECURITIES`, and so on.

**`raw` is used in preference to `value`, and that is not fussiness.** `value`
is a JSON number that has already been through a float; `raw` is the string. For
a VND balance in the hundreds of millions the difference is real money, and the
entire ledger rests on never letting a float hold one. The SDK's own fixtures
contain `15001.116` — three decimals on a two-decimal currency — so rounding at
the boundary had to be deliberate rather than incidental.

The account mapping defaults to **not cash**, and it is the second time that
rule has been written down. A Plaid connection once put a mortgage, a student
loan, an auto loan, a HELOC, a 401k and an IRA into the headline cash figure —
$182,228 of debt reported as spendable — because an unrecognised type fell
through to "other" and "other" counted as cash. Overstating what a company can
spend is the dangerous direction: a balance wrongly left out is visible on the
Accounts page where somebody can turn it back on; a debt wrongly added to cash
is visible nowhere.

In dedup, `finverse` ranks beside `plaid` and **above** `csv_vn_bank`. When the
same Vietnamese transaction arrives from both, the live feed is the one that has
not been through a spreadsheet export, a column mapping and somebody's date
format.

## 66. What the Finverse connector has and has not been proven to do

There are no Finverse credentials yet, so **the HTTP calls in this connector
have never executed**. Saying that plainly matters more than the code does.

What is proven: 22 tests over the pure half — amount parsing at three
currencies and three decimal places, direction from the sign, account-type
mapping including every liability subtype, and the four reasons a row is dropped
rather than guessed at. Four of those run the normalizer against **Finverse's
own example payloads**, copied verbatim from the SDK's fixtures, which is the
closest thing to verification available without a key.

That contract test immediately earned its place: it failed typecheck on
`created_at`, a field Finverse sends that the interface did not declare. A type
that quietly disagrees with the payload is a type that has stopped being
checked, so the declaration now matches what actually arrives.

What is not proven: that the endpoints answer, that the paths are right, or that
a Vietnamese bank returns the same shape as the vendor's HKD examples. The day a
sandbox key exists, the first thing to do is run a real response through
`tests/finverse-contract.test.ts` and see what does not match.

Rows are dropped, never guessed at, and each reason is counted so a sync reports
what it did not take:

- **Pending.** A pending transaction can change amount, change date or vanish.
  Booking one leaves the ledger disagreeing with the bank a day later, and the
  reconcile page then reports a variance nobody can explain.
- **Unknown account.** A transaction whose account was never mapped has no home,
  and inventing one puts real money in the wrong place.
- **No readable amount.** A row we failed to parse is not a zero-value
  transaction.

## 67. Finverse covers individual accounts, and AHN is a company

Checking Finverse's own bank pages turned up something that reorders the whole
Vietnamese plan: for **both** VietinBank and Techcombank, Finverse states
"Bank Data API (**individual accounts**)". AHN banks as a company.

That does not make the Finverse connector wasted — it is written, tested against
the vendor's own payloads, and is the right fallback. But it moves VietinBank
iConnect from "only if AHN would rather go direct" to the **primary** route,
because iConnect is aimed at business partners and its credentials are issued
self-service and instantly.

Worth confirming with Finverse directly before either route is committed to;
their marketing pages are not a contract. But planning around "aggregator first"
without checking would have meant discovering it after the credentials arrived.

## 68. The specification arrived, and four guesses were wrong

The bank's own OpenAPI document (`docs/api-specs/vietinbank-statement-1.0.0.json`)
replaced an earlier draft of this connector that had refused to guess at the
endpoints. Comparing the two is the argument for having refused:

| Guessed | Actual |
|---|---|
| OAuth2 client credentials at `/oauth2/token` | **Not OAuth2 at all** — two apiKey headers, `X-IBM-Client-Id` and `X-IBM-Client-Secret` |
| Separate account and transaction endpoints | **One** `POST /inquiry`, returning a whole statement |
| A signed decimal amount | `debit` and `credit` as **separate string fields**, one empty |
| Two credentials | **Five**: the two keys plus an account number, a providerId and a merchantId |

Every one of those would have failed in a way that looked like a credential
problem. The OAuth2 draft in particular would have produced a 404 on a token
endpoint that does not exist, and the obvious next move would have been to
re-check the keys.

**Six things the specification settled that shape the code:**

1. **`collectionType` is deliberately never sent.** The spec describes it as
   "Loại truy vấn (d ghi nợ, c ghi có)" — a filter for debits *or* credits — and
   its example value is `"d"`. Copying the example would have returned only
   money going out, leaving the ledger missing every payment received while
   looking perfectly complete. This is the single most expensive field on the
   page to copy without reading.
2. **Dates differ between request and response.** `DD/MM/YYYY` going out,
   `DD-MM-YYYY HH:mm:ss` coming back — slash one way, hyphen the other. Getting
   it backwards is answered with an empty statement, not an error.
3. **`status.code` is `"1"` for success.** Every other system here treats 0 that
   way, and a `!code` check would read a response with no status at all as a
   success.
4. **`curency` and `openningBal` are misspelled in the bank's API.** Matched
   exactly on purpose; reading `currency` would silently fall back to a default
   on every statement.
5. **Amounts carry decimals a currency does not have** — `"7192010.00"` for a
   dong figure. The currency drives the scaling, so this lands as 7,192,010 and
   not 719,201,000.
6. **`corresponsiveAccountName` is the counterparty**, straight from the bank —
   far better than parsing a name back out of the description.

Two smaller refusals: a row with *both* debit and credit filled is dropped
rather than half-read, because booking half of an unreadable row puts a real
amount in the ledger pointing the wrong way; and a padded `"0"` is treated as
no value, because a zero is a real number and not a transaction.

Production has **no default address**. The spec's `x-ibm-configuration.servers`
lists the sandbox URL for both "production" and "development", which cannot both
be right, so `VIETINBANK_ENV=production` without `VIETINBANK_API_BASE` is a
configuration error rather than a guess.

`signature` ("Chữ ký số") is in the request schema but the spec declares no
required fields and documents neither the algorithm nor the payload to sign.
Requests go unsigned. If the sandbox refuses them, that documentation and an RSA
key pair are the missing piece — and the refusal message will name it.

## 69. Verified against the bank's own example, not against a mock I wrote

The same pattern that worked for Finverse: the response printed in VietinBank's
documentation is copied verbatim into `tests/vietinbank.test.ts` and run through
the normalizer. It produces exactly one ledger row — 16 Sep 2021, outflow,
15,000 VND, counterparty "CT HOANG HA NGUYEN", external id
`114000121964:1lAfM-7TLoiNEt2`.

A second test walks every `maxLength` the specification declares and asserts the
request builder respects it, `requestId` included — that one is capped at 30
characters and is generated per call, because the bank treats it as the
partner's own reference and a reused one turns a retry into a duplicate.

21 tests, and the HTTP call itself is still unproven: there are no sandbox
credentials yet. What is proven is that every field, format and edge the
document describes is handled the way the document describes it.

## 70. The sandbox answered, and it proved everything except the success path

A live call to
`https://sandbox.vietinbank.vn/vtb/openbanking/erp/v1/statement/inquiry`
came back in 230ms:

```
HTTP 401  {"httpCode":"401","httpMessage":"Unauthorized",
           "moreInformation":"Invalid client id or secret."}
```

A rejection, and a very informative one. It confirms the host resolves, the base
path and `/inquiry` are right, the method is right, and the gateway reads
`X-IBM-Client-Id` and `X-IBM-Client-Secret` and judges them — which settles the
authentication model against a live system rather than against a document.
Every part of the connector is now proven except the success branch.

The credentials in `.env.local` were **`apiKey located in header`** — the
Swagger document's own description of the header, pasted in as though it were
the value. Twenty-four characters, plausible at a glance, and the gateway
answers it with exactly the same 401 as an expired key.

Two changes came out of that:

- **The placeholder is now caught before any request is sent**, and named. Left
  alone, nothing on screen could distinguish "I copied the wrong line" from "my
  key stopped working".
- **Gateway errors are read rather than dumped.** The API Connect layer rejects
  before the bank sees anything, and its shape (`httpCode`, `httpMessage`,
  `moreInformation`) is different from the in-body `status` a business rejection
  uses. A 401 now says it is the keys and not the account number or the partner
  identifiers; a 404 says it is the host or path and not the credentials. Those
  are the two wrong turns this API makes easy.

## 71. A security audit of the running application, not of a checklist

The full report is [SECURITY.md](../SECURITY.md). Five real issues, each found
by testing the running system.

**The one that mattered most: an open redirect in the sign-in callback.** It
redirected to `${origin}${next}` with `next` straight from the query string, so
`?next=//evil.com` became `https://ourapp.com//evil.com` — protocol-relative,
followed off-site by every browser.

The grade of bad is specific to this application. The victim clicks a sign-in
link, authenticates **successfully against the real system**, and is then handed
to a page an attacker chose. A page that can look identical and ask them to sign
in again. In something holding a company's bank connections, an
attacker-controlled landing page immediately after a genuine login is a phishing
primitive.

The other four: no CSRF protection on 20 state-changing routes, no rate limiting
anywhere, a `safeEqual` that leaked the secret's length by returning early on a
mismatch, and no CSP or HSTS at all.

**Seven routes could not be guarded without changing their signatures.** They
were written `export async function POST()` with no `request` parameter, so
there was nothing to inspect for an origin — and they were the most consequential
routes in the application: `/api/sync`, `/api/transactions/recategorize`, and
every integration connect button.

Three decisions inside the fixes worth keeping:

- **Rate limits are per-route, chosen by what a call costs somebody else.** The
  alert-test routes are limited because they deliver real Slack messages the
  webhook identity cannot delete; the bank routes because repeated failed
  authentication is what gets an API key suspended.
- **The limiter is honest about being in-memory.** Per-instance, forgotten on
  restart, useless against a distributed attacker. It is a courtesy to upstream
  providers, and SECURITY.md says so rather than implying a control that is not
  there.
- **The CSP keeps `'unsafe-inline'` for scripts** because Next.js inlines its
  hydration payload, and removing it needs per-request nonces. That is recorded
  as the highest-value remaining step rather than left off the list.

**Every claim was executed, not asserted.** A cross-origin POST returns 403; a
same-origin POST reaches validation; seven rapid calls return
`200 200 200 200 429 429 429`; four redirect payloads all resolve to our own
host; the owner cannot UPDATE or DELETE an audit row and all 44 survive.

Two things the audit confirmed were already right, and both had been proven the
hard way before: RLS is the enforcement boundary and is tested with a real
viewer token rather than a service-role query, and `audit_logs` has no UPDATE or
DELETE policy at all, so the trail is append-only by construction rather than by
convention.

## 72. Five of the six budget figures are arithmetic; the sixth is a guess

Spec section 19 asks for budget, actual, remaining, variance %, projected final
cost, and alerts before overspend occurs. The first four and the alert are
mechanical. **The projection is a claim about the future**, and it is the figure
a budget page usually gets wrong in the direction that matters.

Two days into a month, one large payment makes a straight run rate read many
times the budget. Print that number and the reader learns to ignore the column —
and then misses the one time it was right.

So `projectionConfidence` is returned beside every projection, built from the
two things that actually undermine a run rate:

- **How early it is.** Below half way, elapsed time is the limiting factor; a
  tenth of the way through, nine tenths of the answer is extrapolation.
- **How lumpy the spending is.** One payment is not a run rate. Eight starts to
  behave like one.

Below 25% the page prints **"too early to say"** rather than a number. The
at-risk tile counts only projections at 50% or better — an alert that is wrong
half the time is already borderline.

Three smaller decisions from the same reasoning:

- **The period end is derived, never stored.** Stored separately, a month budget
  could be saved with an end date that is not the end of that month, and every
  projection off it would be quietly wrong.
- **Today counts as elapsed.** Money spent today is spent; an off-by-one here
  shifts every projection.
- **Future-dated rows do not count.** Spending that has not happened is not
  spending, and counting it charges a period the company has not reached.

There is deliberately **no combined projected total**. Budgets overlap by design
— a category budget and a business-unit budget can cover the same payment — so
summing their projections would double-count while looking authoritative.
Overlap is fine per budget and wrong in a sum.

## 73. The overspend alert fires on a guess, so it is careful about which guess

Section 19 says alerts "before overspend occurs". The word *before* is the
requirement: an alert that fires once a budget is already over is a
notification, not a warning — by then the money is gone.

That means firing on the projection, which means it can be wrong. Three things
keep it from becoming noise:

1. **It will not fire below 50% projection confidence.** The run rate has to be
   worth believing first.
2. **It fires once per budget per period**, deduped through
   `notifications.context` — the same event-keyed approach as the
   price-increase alerts (decision 46), not a daily cooldown that would
   re-announce the same overspend every morning.
3. **It fires again, once, if the budget actually goes over.** That is a
   different fact from "heading over", and the dedupe key carries the stage so
   the second is not suppressed by the first.

An actual overspend does **not** need projection confidence — it is a fact, not
a forecast. Verified live: an August budget of $3,510 against $5,850 of real
payroll fired *"is over budget by $2,340.00 — $5,850.00 spent against a $3,510.00
budget, with 11 days still to run"*, the second sweep sent nothing, and a sweep
dated after the period closed sent nothing at all.

## 74. Two budgets for one project, and saying so

`projects.budget_expense_minor` already held a lifetime budget: what a fixed
piece of work may cost in total. The new `budgets` table holds period budgets:
what something may cost this month or quarter.

Both are legitimate and they are different numbers measuring different things.
A project can carry both, and a reader seeing two budget figures for one project
without being told why will assume one is a bug.

Rather than migrating one into the other — which would have meant changing
`computeProjectPnl` and its tests to serve a page it does not belong to — the
budget page **detects the overlap and explains it**. Same pattern as the labour
double-count warning (decision 54): where two legitimate sources can disagree,
say so on the page instead of picking a winner silently.

## 75. A bill is a promise AHN made; an invoice is one somebody made to AHN

Spec sections 17 and 18 are the same shape — an amount, a counterparty, a due
date, a status, and eventually the transaction that settled it — so they are one
table with a direction, for the same reason an event is a project (decision 51).
Aging applies to both: an overdue bill matters as much as an overdue invoice.

**The figure the whole feature exists for is committed cash**: today's balance
minus everything owed inside the horizon. A company with $200k in the bank and
$180k of payroll due on Friday does not have $200k, and until now every cash
figure in this system said it did.

**Receivables are deliberately excluded from it.** That asymmetry is the point.
Payroll on Friday happens on Friday; an invoice can be paid late, disputed, or
never. Counting expected receipts in the number a person plans against is how a
company runs out of cash while its dashboard reads healthy. The optimistic
figure is shown too, separately, and labelled as the optimistic one.

Verified against the live ledger: cash $77,860.57 less $75,924.51 of
commitments left **$1,936.06**, matching the hand calculation to the cent. One
more commitment pushed it to **−$7,067.11**, and the page named the day it goes
short and how much of the outstanding invoices would cover it.

Three smaller decisions:

- **`not_due` is a separate bucket from `current`.** An invoice due next week
  and one that fell due this morning are in completely different states, and a
  single "current" bucket hides which is which.
- **Settled rows leave the aging buckets.** A paid invoice sitting in a 90-day
  bucket makes a collections problem look worse than it is.
- **A currency with no rate contributes zero**, the same rule the ledger uses.
  Understating what is owed is recoverable; a 25,000× overstatement of a dong
  commitment is not.

## 76. The obligation that was already paid

Once a bill is paid the payment is in the ledger, and the obligation stays open
until somebody marks it settled. Until they do, committed cash subtracts it a
second time — telling a company that has already paid its rent that it still
has to.

Nothing in the database prevents that, so `findLikelySettled` looks for a
transaction matching an open obligation on amount, direction and a seven-day
window, and the page says so.

**It is a suggestion, never automatic.** Matching on amount and date is the same
heuristic the duplicate detector uses, and it is wrong often enough that
settling an invoice on its say-so would eventually close one nobody paid. One
payment can also claim at most one obligation — two invoices for the same amount
and a single payment means at most one of them was paid by it.

Found live against the real ledger: a $3.17 Stripe fee correctly matched a
commitment recorded for the same amount and date.

## 77. Overdue alerts keyed by aging bucket, not by day

Section 17 asks for alerts on overdue invoices. The trap is obvious once
stated: an invoice 40 days overdue is still 40 days overdue tomorrow, and a
daily reminder is how a channel stops being read — the same failure the
price-increase alerts were designed around (decision 46).

So the dedupe key carries the **aging bucket**: `{id}:d31_60`. Crossing from 30
days into 60 is new information and fires again; the twenty-nine days in
between say nothing.

Two rules, one sweep, both with floors chosen by whether acting is worth it:
overdue invoices below $100 are not chased because the chase costs more than the
debt, and upcoming commitments are announced at $1,000 or more inside a
fortnight.

Verified live: four alerts on the first sweep — *"$5,850.00 due to Gusto in 4
days"*, *"$70,074.51 due to Landlord in 12 days"*, *"$4,000.00 expected from
Prompt Client in 10 days"*, *"Slow Client is 45 days overdue"* — and zero on the
second.

## 78. Capabilities, not role names, in twenty-eight policies

Spec §23 names seven roles. Week 1 shipped two, and SECURITY.md listed the gap
as a known weakness.

Written the obvious way — `role in ('owner','cfo','accountant')` in each policy
— every future change to who may do what means editing 28 places and getting all
28 right. **One missed policy is a silent hole no test would notice**, because a
policy that grants too much still returns rows.

So the matrix lives in one function per capability, and every policy asks about
the action: "may this reader see compensation?", never "is this reader one of
these three roles?". `src/lib/capabilities.ts` mirrors it for the interface, and
the database is the authority — `tests/rbac.integration.test.ts` runs the real
policies with a real token per role, so a drift between the two fails a test
rather than quietly granting something.

**Scoped roles see LESS than a viewer, not a subset of the owner.** A viewer is
trusted with the whole company picture minus compensation. A department lead is
trusted with their unit; a project manager with their projects; an employee with
their own record and hours. Those are different axes, and treating a lead as a
lesser owner would hand them the company.

Probed live, and the matrix came out exactly as designed — the accountant sees
every transaction including payroll and the audit log but **zero** integrations,
because reclassifying a payment is their job and holding a bank credential is
not.

## 79. A write policy was silently granting reads

Every write policy in the first draft was `FOR ALL`. In Postgres that **covers
SELECT**, and RLS policies on a table are OR-ed — so a permissive `FOR ALL`
write policy grants a full-table read to anybody it lets write, whatever the
scoped read policy beside it says.

Effect, found by probing with a real department-lead token: they could read
**every** project, including ones in no unit owned by nobody, while the read
policy carefully restricted them to their own. The scoped policy was correct and
completely bypassed.

Transactions escaped only because their write policy happened to be `FOR UPDATE`
rather than `FOR ALL` — an accident, not a decision.

Write policies now say exactly which writes they mean, on every table, including
the ones where the capabilities currently happen to overlap safely. "This one is
fine because of how two other functions line up today" is not a property worth
depending on.

**Nothing in the test suite would have caught this.** It came from reading a
probe's output and asking why a number was 2 when it should have been 1.

## 80. Two more things that probe found

**A department lead could create a project in any unit — or in none.** The write
capability was unscoped while the read policy was scoped, so they could create a
row and then not see it. A row somebody can create and cannot then read is not a
permission model, it is a trap. Write scope now matches read scope: they write
inside a unit they lead, and owner and CFO keep the unrestricted path.

**Migration 0024 claimed to be idempotent and was not.** It created policies
under new names without dropping them first, so the second run failed — and
because the runner stops on error, **migration 0025 silently never ran**. The
symptom was a fix that appeared not to work. Every new policy is now dropped
first, and the header says why.

`ownerOnly` on 23 API routes was left as a name but now means the `move_money`
capability. Read literally after §23, every route written in week 1 would have
locked out the CFO — whose job it is.

---

## 81. The AI CFO layer, built from the bottom

Spec §20 opens by drawing a line: AI should *"interpret deterministic financial
data rather than calculate foundational accounting numbers itself."* Plan §11
then gates the interpretation on "2-3 months of clean data". The ledger holds 135
sandbox transactions, so the top half cannot honestly be built yet — but the
bottom half can, and it is the half that has to be right. `src/lib/calc/explain.ts`
is the arithmetic that layer will one day read, and `/explain` is that arithmetic
with nothing on top of it. No model is called anywhere on the page.

**The breakdown reconciles exactly or it says so.** Opening plus money in, less
money out, equals closing — checked in whole cents, not within a tolerance. A
breakdown that is off by $3 is worse than no breakdown: a reader who checks it
once and finds it wrong stops trusting every other figure on the page. When it
does not reconcile the page leads with that, rather than showing numbers that
quietly disagree with the balance printed above them.

**Internal transfers are counted on neither side.** They net to zero across the
position. Including them would inflate money-in and money-out by the same amount
— still reconciling, still misleading about what the company earned and spent.

**Movers are grouped by counterparty, not by category.** "Revenue fell because
professional services fell" tells nobody anything they can act on. "Acme paid
$40,000 last month and nothing this month" is a phone call. Categories explain
*what* moved; only a name explains *who*, and only a name can be rung up.

**Anomalies are judged per vendor, against that vendor's own history.** The
existing alert rule fires on any transaction over a flat $5,000. That threshold
fires on every payroll run — which is not news — and stays silent on a $300
charge from a vendor that has never once charged more than $20. So each vendor is
scored against its own median and its own median absolute deviation, and a
payment must sit above both to be reported. A vendor genuinely variable by nature
never trips it; a vendor with a settled pattern trips it the first time the
pattern breaks. Four payments of history minimum, because calling a vendor's
second-ever payment unusual is noise, and noise trains people to skip the list.

**One line per vendor, found by reading the live output rather than the tests.**
The first run returned three anomalies and all three were Stripe processing fees
— $246.80, $93.10, $36.55 against a typical $3.91 — because a percentage fee
scales with the payment it settles. The maths was right and the output was
useless: three lines about one vendor is exactly the repetition that teaches a
reader to stop reading. The list now shows each vendor once, at its largest, with
the others counted in `alsoUnusualCount` and a reason that says the vendor's
charges appear to vary with something else. Nine unit tests passed before this
was found. None of them could have found it.

**The uncategorised share is stated, not decorated.** 26% of everything AHN spent
in the last 90 days — $8,173.54 across 25 payments — has no category, so the
page says "26% of the spending has no category" and links to the fix. An earlier
draft hardcoded "A quarter of the spending". It reads well at 26% and lies at
60%, and a heading nobody can trust is worse than no heading at all.

---

## 82. Exchange rates that fetch themselves

Spec §3 wants multi-currency reporting; plan §8 lists "complete multi-currency
reporting, automatic VND/USD conversion" under Phase 3. Until now the only way a
rate reached the table was somebody typing it, and the seeded rate of 0.0000380
had drifted 1.2% from the market by the time this was written. Nothing in the
system would ever have said so.

**Vietcombank first, mid-market second.** A Vietnamese company's books are
expected to use a commercial bank's rate rather than an index nobody will trade
with them at, and Vietcombank publishes a free XML file with Buy, Transfer and
Sell for twenty currencies. It also prices everything in VND, so one fetch
prices the whole ledger: one SGD is (VND per SGD) / (VND per USD) dollars.
exchangerate-api fills what the bank does not list. Neither needs an API key,
which is the difference between a feed that runs today and a feed that waits on
somebody's signup.

**The dong is valued at the bank's SELL rate.** AHN holds dong and reports in
dollars, so the honest question is what those dong would actually fetch, and
turning VND into USD means *buying* dollars at the dearest of the three columns.
Today that is 26,260 against a mid-market 26,007 — a 1% haircut, in the
direction of understating what AHN has. That is the same direction `fx.ts`
already takes when it values an unpriced currency at zero rather than 1:1. A
runway that turns out longer than forecast is a good morning; one that turns out
shorter because the books used a rate no bank would honour is the failure this
system exists to prevent. Cross rates use Transfer instead, because applying a
retail cash spread twice to a currency AHN merely reports in would understate it
for no reason.

**A rate a person set is never overwritten.** If the CFO typed the rate a deal
closed at, or the rate an auditor agreed, a robot must not quietly replace it the
next morning. The feed writes only where no human has, and only for that date —
so the blast radius of a hand-set rate is exactly the day it was set for.

**An implausible rate is refused, not written.** The failure this guards against
is not a rate wrong by a percent. It is a rate wrong by 26,000x because a
provider quoted dong-per-dollar where we expected dollar-per-dong, or wrong by
95% because a parser picked up the neighbouring currency's row. Every cash,
runway and break-even figure in the company is downstream of this one number.
So a rate must clear an absolute band and sit within a drift allowance that
grows with the gap since the last known rate — 5% overnight, never more than 25%
however long the feed has been down. A refused rate leaves yesterday's standing
and is reported separately from failures, because it means a source answered and
we did not believe it, which is a different thing from an outage.

**The bank's own date stamp is ambiguous and is resolved by proximity.**
Vietcombank writes "9/2/2026" and never says which half is the month. On the 2nd
of September both readings parse, and choosing wrong would file September's rate
under 9 February, where a dated lookup would then serve it for seven months. Both
readings are built and the one nearer the fetch date wins; a result in the future
or older than a fortnight means the format moved and the fetch date is used
instead.

**The job runs an hour before the digest, not after.** Every USD figure the
morning digest reports is converted through this table. It is also kept off the
ten-minute sync tick, because Vietcombank asks for no more than one request every
five minutes and a feed that gets AHN rate-limited is worse than one that runs
daily.

**Two things the first live run found.** The feed wrote nothing: a hand-set rate
already existed for the day, so the keep-the-human rule fired — correct, but the
integration test had asserted only "there is a rate afterwards", which passes
whether or not the feed did anything. That is the same shape of green-but-empty
test as the price-increase one in decision 44. The live test now names which of
the three branches it took and fails if none did, and the write path is proved
separately against a stub that records the actual upsert.

The second: `RateEditor` printed "as of {asOf}" where `asOf` was *today*. A rate
set three weeks ago and untouched since claimed to be today's — and that line was
the only place in the app that could have admitted otherwise. It now shows the
rate's own date, where it came from, and how many days old it is, with a callout
when a held currency's rate passes a week.

---

## 83. Slack slash commands, and the gate behind them

Spec §5 closes with "Optional future enhancement: Slack commands and
natural-language financial queries"; plan §8 lists it under Phase 3. This is the
commands half. Every answer is the same arithmetic the dashboard shows, read out
of the same engine — nothing here is a model, and a word the parser does not
know produces the help text rather than a guess. A finance bot that answers
approximately is worse than one that says it did not understand.

**Two gates, and the second is the one that matters.**

The first is Slack's signature. Without it, anyone who learns the URL can ask
the company how much cash it has, because the `user_id` in the body is a form
field the sender wrote. Requests are verified against the signing secret over
the raw bytes — re-serialising parsed form data changes ordering and encoding,
and the signature then fails for reasons that look like a Slack outage for an
afternoon. With no secret configured the endpoint refuses to run at all rather
than falling open, the same stance `authorizeCron` takes.

The second is identity, and it is the reason this feature needed a migration. A
verified signature proves *Slack* sent the request. It says nothing about
whether that person may see AHN's money. **Slack workspace membership is not
AHN's permission model** — contractors, agency staff and every future hire sit
in the same workspace. So `users.slack_user_id` maps a Slack account to exactly
one app user, and that user's role decides the answer. Without it this endpoint
would have been a hole straight through migrations 0022-0025: RLS on every
table, and then one slash command handing the whole picture to the room. An
unmapped id is refused by name, and told that being in the workspace is not by
itself permission.

The unique index on that column is part of the boundary, not tidiness: without
it a second row could claim the same Slack id, and the lookup would silently
take whichever came back first — a way to acquire somebody else's permissions by
editing your own row.

**Every reply is ephemeral.** The permission check is per person; posting the
answer into the channel would hand it to everyone in the room regardless of
their role, which would make that check decorative. Someone who wants to share a
figure can paste it themselves, deliberately.

**The service role is used here, and that is why the check comes first.** There
is no Supabase session behind a Slack request, so RLS cannot identify the caller
and the admin client is the only way to read anything. That makes the capability
check the *only* boundary — so it runs before a single row is fetched, and every
command is read-only.

**What reading the live output changed.** `/ahn cash` first replied
":warning: 17 account(s) do not reconcile with what the provider reports." Every
word was true and the line was still wrong. `balanceMinor` uses the provider's
reported balance wherever there is one, so the total *is* the banks' own figure
— the variance says our transaction history does not yet explain that balance,
which is expected until opening balances are entered. A siren on every `/ahn
cash`, over a known and pending condition, is how people learn to skip the line
that one day matters. It now states the completeness gap plainly, without the
warning.

**A test that passed for the wrong reason.** The "refuses to run with no signing
secret" case passed `signingSecret: undefined`, which falls back to
`process.env` — so it was really asserting that the developer's own `.env.local`
lacked the key. Adding `SLACK_SIGNING_SECRET` turned it red, which is how it was
found. It now stubs the environment and tests the real condition.

---

## 84. Two bugs the rate feed's own output confessed to

The feed shipped yesterday could not be fully verified then: a hand-set rate
existed for the day, so the keep-the-human branch fired and the write path never
ran. Re-running it the next morning proved the write — and printed two things
that were wrong.

### "Today" was UTC, and AHN is not

The feed filed the new rate under **2026-09-02** while every clock in the office
said the 3rd. The machine was on `Asia/Saigon` at 00:42; UTC was still on the
2nd; `today()` returned `toISODate(new Date())`, which is the UTC date.

`dates.ts` opens by saying every function works in UTC so that "financial period
boundaries must not drift with the viewer timezone". That reasoning is right and
it still stands — for arithmetic over dates that are *already stored*. A
transaction booked on the 1st has to sit in that month for a reader in
California and a reader in Ho Chi Minh City, and `monthStart`, `addDays` and
`formatDayLabel` all keep pinning UTC for exactly that reason.

But "what month does this stored date belong to" and "what day is it right now"
are different questions, and the second one has a right answer that depends on
where the business is. Between midnight and 07:00 in Vietnam — and on Vercel,
which runs in UTC, this is every day — the dashboard's "as of" named the wrong
day, break-even counted a day that had already ended, and any rate fetched in
that window was filed under yesterday. At month end it is worse than cosmetic:
30 September 23:00 UTC is already 1 October in Vietnam, so a figure would land
in the wrong month at precisely the moment somebody is closing the books.

So `today()` now resolves in `BUSINESS_TIME_ZONE`, defaulting to
`Asia/Ho_Chi_Minh`, and `formatDateTime` renders in it too — without that, "last
synced 5:42 PM" was being shown to somebody for whom it was 12:42 AM. Everything
else stays in UTC. An unknown zone name falls back to UTC with a warning rather
than taking the app down over a date.

`en-CA` is not a style choice: its short date format is already YYYY-MM-DD, so
there are no parts to reassemble and no locale can quietly reorder day and month.

### The "unchanged" branch was unreachable

The second run printed `second run: 1 written, 0 unchanged`. It should have said
unchanged — nothing had moved.

`exchange_rates.rate` is `numeric(20,10)`. The code computed 1/26260 as
`0.00003808073115003808` and the database stored `0.0000380807`. Read back, the
two never compared equal, so `sameDay.rate === quote.usdPerUnit` was false every
time: the feed rewrote the same row on every run and reported each rewrite as
new. Harmless to the data, and a quiet lie in the telemetry — the branch that
says "nothing changed" could never once execute.

Rates are now rounded to the column's own scale before they are compared or
stored, so what the code holds and what the database holds are the same number.
Ten decimal places leaves the dong six significant figures: under one part per
million, or eight cents on a hundred thousand dollars.

Both were found by reading output that had already gone green. The unit tests
could not have caught either one — the first needed a machine whose local date
disagreed with UTC, and the second needed a real round trip through Postgres.

All three decision paths have now been observed against live data: **written**
(this morning), **kept a human rate** (yesterday), and **unchanged** (the second
run this morning).

---

## 85. Receivables and payables, pulled from QuickBooks

Spec §17 and §18 wanted AR and AP; migration 0019 built the table for them in
Phase 2, and until now every row had to be typed in. The invoices were already
in QuickBooks. The connector had always skipped them on purpose — an invoice and
the payment that settles it are two records of one event, and ingesting both
would double every dollar AHN earns — but skipping them for the *ledger* is not
a reason to leave them out of the *obligations* table, which exists precisely to
hold money that is going to move rather than money that has.

**An accrual is live state, not history — and that is the whole design.**

The transaction sync pulls incrementally from the last successful run, which is
correct: a transaction is immutable, so anything older has already been seen.
The first version of this reused that instinct and filtered invoices by
`TxnDate >= since`. Against the real company it returned **nothing at all**,
while QuickBooks held 31 invoices and 15 bills — every one of them dated before
the last sync. An invoice raised in June is still owed in September, and its
balance moves without its transaction date ever changing.

A sync that reports "0 imported" with no error is the worst possible way to be
wrong, and no unit test would have caught it: the code did exactly what it was
told. It was caught by asking QuickBooks how many invoices it *actually holds*
and comparing — which is now a permanent assertion, so "none" can never again be
mistaken for "none found".

So there are two queries per entity, unioned on the row id:

1. `Balance > '0'` — every open item, however old. This is the live state §17
   ages and chases.
2. `MetaData.LastUpdatedTime >= since` — anything touched since the last run.
   Without it, an invoice that got PAID would simply stop matching query 1, and
   the obligation already stored for it would sit open forever, ageing into the
   overdue bucket and being chased after it had been settled. A row has to be
   told it was paid.

They are separate calls because the QuickBooks query language has no `or` —
asking for one returns HTTP 400 — and the `'0'` is quoted because unquoted the
parser rejects the statement. Both were established by probing the real API
rather than by reading about it.

**`amount_minor` means different things open and settled, and that is forced.**
While open it is the outstanding balance, which is what gets chased. Once
settled the balance is zero, and the column carries a `> 0` check because an
obligation for nothing is not an obligation. The aging engine reads a settled
row's amount into `paid`, so the honest number there is the contracted total.
`contracted_amount_minor` always holds what was originally agreed, which is what
§17 means by asking for contracted *and* invoiced.

**The settlement date is an approximation and says so.** QuickBooks does not put
it on the invoice; it lives on the linked Payment, a second query per row. The
day QuickBooks last changed the record is the closest available signal, and it
is written into the row's notes as exactly that rather than presented silently
as the payment date. It falls back to the issue or due date, never to today —
"we noticed it today" is not a date anything financial happened, and a
`settled_on` of today would quietly sweep every old invoice into this month's
paid figure.

**A partial unique index cannot be an upsert target.** `external_id` was first
indexed `where external_id is not null`, on the assumption that hand-entered
obligations would otherwise compete for a single null slot. They would not:
Postgres treats nulls as distinct in a unique index. And Postgres will not let
`on conflict (source_system, external_id)` name a partial index — it cannot
prove the statement only touches the indexed subset — so every upsert failed
with "there is no unique or exclusion constraint matching the ON CONFLICT
specification". The index is plain, and the migration drops the partial one.

**Counterparties are matched, never created.** An invoice whose customer has
never appeared in the ledger keeps its name and no id. Creating counterparty
rows for organisations that have never transacted would put them in front of the
anomaly detector and the subscription detector, which reason over payment
history — and an entity with no payments has no history to reason about. 34 of
46 matched an existing row; the other 12 carry their name.

Verified against the live company: 46 rows in, 21 recognised as already settled,
and a second pass inserting nothing. Through the real cron path, 25 open items
refreshed and none duplicated. The page reconciles — $77,860.57 cash less
$1,602.67 owed out is the $76,257.90 it calls genuinely spendable, and the
$5,281.52 of receivables is shown separately because a bill is a promise AHN has
to keep and an invoice is a promise somebody else made.

---

## 86. Handing out permissions without the SQL console

Spec §23's seven roles were enforced from migration 0022 onwards, but there was
no way to *assign* one except SQL or the create-user script — and after 0026 the
same was true of linking a Slack account. Both sat on AHN's checklist as "run
this UPDATE": no audit trail, no guard rails, and needing the one credential
that can do anything.

**`users` had a read policy and no write policy at all.** So the only way to
change a role was the service role, which bypasses RLS by design. A route using
it would have been the only thing standing between an employee and the owner
role. Every other permission in this system is proved at the database; this one
is now too. `/api/access` runs on the caller's own session client and would
refuse the same things with the file deleted — what it adds is the audit entry
and a readable error.

**Three invariants a policy cannot express, so they are a trigger.** A policy
answers "may this person write to this row"; it cannot see what the row is
*becoming* relative to who is asking.

*Nobody changes their own role.* Otherwise the model is advisory: any role that
can manage people can promote itself, and any owner can demote itself out of the
company by accident.

*The last owner cannot be demoted.* An organisation with no owner has nobody who
can appoint one, and the only way back is the console this work exists to avoid.

*`auth_id` and `email` are not editable here.* This is the quieter escalation:
leave the role alone and change whose login the row belongs to. `auth_id` is
what maps a session to a role, so re-pointing it hands that login this row's
permissions. Not blocking it would have made the first two guards decorative.

**A read policy that had drifted.** `p_users_read` was still `is_owner()` from
migration 0002, written before the seven roles existed — so a CFO, who
`can_manage_people()`, could edit `people` rows but could not see the `users`
roster they were supposed to manage. It is now `can_manage_people() or auth_id =
auth.uid()`, which also gives the page a useful shape for everyone else: someone
without the capability gets exactly one row back, their own, and the page
answers "what am I allowed to do?" rather than refusing. That is the database
drawing the line rather than an `if` in a component that could drift away from
it — which is exactly how this policy drifted in the first place.

**Verified from outside, with real tokens.** Nine assertions through the anon
key plus each person's own access token, which is what a browser sends: a viewer
sees only their own row; a CFO sees everyone; a viewer cannot promote themselves
or anybody else; a CFO can change others but not themselves; `auth_id` and
`email` are both refused; a Slack link lands without disturbing the role. Live
through the route: the trigger's message reaches the user verbatim, a malformed
Slack id is refused with an instruction rather than a validation code, a
lowercase id is normalised, and the change is audited.

**The branch not covered, said plainly.** Demoting the last owner can only be
attempted when exactly one owner exists, and the only owner here is AHN's real
account — exercising it would mean demoting the live company's owner and hoping
to put it back, which is a worse risk than the one being tested. The trigger is
proved installed and firing by the self-role refusal, which comes from the same
function; a logic error inside the last-owner branch specifically would not be
caught. The page therefore warns while only one owner exists, because the
database can refuse a demotion but cannot stop an account being lost.

**Creating a login stays on the command line.** It means creating an auth
account, which needs the service credential; that should not be reachable from a
browser session, so `scripts/create-user.mjs` remains the way in.

---

## 87. Spec §16, which was computed and never shown

`rollUpBy` groups project P&Ls by business unit, service, client, kind or
status. It was written in Phase 2 with nineteen passing tests, one of which
proves every grouping sums back to the portfolio total — and it was called from
nowhere but those tests. Spec §16 is a numbered section of the requirement and
the arithmetic for it had been sitting finished and invisible.

**It goes on `/projects`, not on a page of its own.** The roll-up is the same
data the page already loads, grouped — a second page would mean a second query
for figures that must agree with the first, and the nav is already sixteen rows
long. A `?by=` switcher covers the five dimensions.

**Nothing is recomputed.** The groups are built from the per-project P&Ls
rendered directly above them. A roll-up derived independently would be a second
implementation of the same arithmetic, and the first time the two disagreed
nobody could tell which was wrong.

**The reconciliation is on the screen, not just in a test.** `tests/projects.test.ts`
asserts each dimension adds back to the portfolio total; the footer row shows it,
and says "does NOT match" when it fails. A reader who can see the group totals
equal the headline figure does not have to take somebody's word for it. Projects
with nothing in the dimension land in an explicit "Not set" group rather than
being dropped, which is what makes the sum hold — and grouping by client, where
no probe project had one, put the whole portfolio in that group and still
balanced.

**A margin on no revenue is a dash, not 0%.** Zero per cent reads as breaking
even. It is the same rule the rest of the engine follows: null is not zero.

### Verifying a page for data that does not exist yet

AHN has no projects and no transaction attributed to one, so the roll-up
rendered nothing at all — the section sits inside the page's has-projects
branch. Shipping it on the strength of unit tests would have meant shipping a
rendering nobody had seen.

So three probe projects were created across different business units, twelve
existing transactions were attributed to them, all five dimensions were
rendered, and then every `project_id` was set back to null and the projects
deleted. Nothing survived the run: zero projects, zero attributed transactions,
confirmed after. The ledger itself was never edited — only which project its
rows pointed at, and only for the length of the probe.

Reading that output found two things no test would have:

**Negative percentages used an ASCII hyphen while money used a true minus.** A
row reading `−$500.00  -8%` makes a reader stop on the typography instead of the
number, and the two sit in adjacent columns of the same table. `formatPercent`
now matches `formatMoney` — and refuses to render `−0%`, because a value that
rounds away to nothing is not negative.

**The status grouping printed raw enum values.** `active` and `completed`, in
lower case, in the same column as "Projects" and "Events" — because
`dimensionOf` returned a proper label for `kind` and the bare column value for
`status`. `label` is display text or it is nothing.

---

## 88. Letting people log their own hours

Every project P&L in this system carries the same caveat: labour is not counted.
The reason was not that §13 was unbuilt — the table, the costing bases and the
loaded-cost arithmetic have all existed since Phase 2. The reason was that
`time_entries` could only be written by `can_manage_people()`, so the owner had
to type everybody's timesheet. Which means nobody's timesheet got typed, and
`time_entries` is empty. §12's whole premise is that a project three people
worked on for a month should not read as profitably as one nobody touched.

**Two things were missing, and only the first is obvious.**

The first is write access to your own rows. The second is something to log time
*against*: an `employee` owns no project and leads no unit, so
`scoped_project_ids()` returns nothing and they could not see a single project
to pick. Self-service was impossible on that ground alone, and no amount of
loosening the write policy would have fixed it.

**A view, because RLS is row-level.** `projects` carries contracted revenue,
invoiced revenue and budget. Someone choosing what to log against needs the name
and nothing else, and a policy cannot hand back a subset of the columns. So
`projects_for_time` exposes id, name, code, kind, status and unit — no money —
filtered to open projects, for signed-in app users. It runs as its owner rather
than as the caller, deliberately, because the point is to bypass
`p_projects_read` and substitute a narrower rule. Everything commercially
sensitive stays behind the table's own policy, and a test asserts that none of
the three money columns appears in the view's output.

**`person_id in (select id from people where user_id = current_app_user_id())`
is both halves of the question.** It is "may I write" and "may I write AS this
person". Without the second half an employee could log hours against a
colleague — changing that colleague's cost, and through it a project's margin.
The `with check` on UPDATE is as strict as the `using`, or a row could be moved
out from under the rule that allowed the edit; a test attempts exactly that.

**A fortnight, because hours are financial data.** A timesheet rewritten months
later silently restates a margin somebody has already reported to a board.
Self-service is limited to the last 14 days. Owner and CFO stay unrestricted,
because correcting an old entry is precisely their job.

**The `+ 1` on that window is not slack, it is a timezone — and it was load
bearing on the day it was written.** The database clock is UTC and AHN works in
UTC+7. When this ran, `current_date` was 2026-09-02 while the app's own
`today()` said 2026-09-03. Without the extra day, an employee logging Thursday's
hours on Thursday morning would have been told Thursday was in the future —
every day, for the first seven hours of it. Decision 84 fixed the application's
clock; this is the same divergence surfacing in a policy, where the fix has to
be expressed differently.

**The route lost its capability gate rather than gaining a check.** `person_id`
arrives from the body and is not compared against the caller anywhere in
TypeScript. It does not need to be: the policy already answers that question,
and adding a second check in the route would imply the database's was optional.
What the route does add is translation — Postgres says "new row violates
row-level security policy", which is true and useless; the reader needs to know
it is either not their timesheet or not a date they may still change.

**Proved twice.** Eight assertions through the anon key with an employee's own
token, with no application code in the path: logs its own hours, refused for a
colleague, refused a month back, corrects yesterday, cannot reassign an entry,
sees project names without money, still cannot read `projects`, still cannot see
a colleague or what they cost. Then the same employee driven through the real
page and route: the project appears in the picker, no contract value renders,
today's hours save, a colleague's are refused with a sentence rather than a
policy error, and exactly one row reaches the table. Every probe row was removed
afterwards — the ledger, the two real users and the empty project list are as
they were.

---

## 89. Closing the loop the timesheet opened

Decision 88 shipped self-service time tracking and ended with a checklist item
for AHN: link each person to their login. There was no way to do that except the
SQL console — `people.user_id` appeared nowhere in the people page, its API
route or any component. A feature whose first step needs a database client is
not self-service, and this is the second time in three decisions that shipping a
capability created a "run this UPDATE" task (the first was Slack ids, decision
86). The pattern is worth naming: when a column starts deciding what somebody is
allowed to do, it needs a screen in the same change.

**A bug the review found, in the page shipped one decision earlier.**

`/timesheet` identified "me" as `people.find(p => p.user_id !== null)` — the
first person row with a login attached. For an employee that is correct, because
RLS returns them exactly one row. For anybody who can see compensation it is
badly wrong: an owner gets EVERY person back, and the first linked one is very
unlikely to be them. The owner would have been shown a colleague's timesheet and
logged their own hours against that colleague's cost — silently, with RLS
permitting all of it, because an owner may write anyone's time.

It came from testing the feature with an employee only. The row filter now
matches `session.user.id` in the query, and a probe asserts the owner still sees
"not linked" while a linked person exists — which is the shape the bug had.

**One login is one person.** `people.user_id` had carried no constraint since
0013, which was survivable while nothing read it. Migration 0029 made it decide
whose timesheet you are filling in, and two rows pointing at one login would
make `may_log_own_time` true for both while the page picked whichever came back
first. Migration 0030 adds the unique index — plain, not partial: Postgres
treats nulls as distinct, so the contractors who will never have a login coexist
under it, and decision 87's lesson about partial indexes and `on conflict`
applies here too.

**The picker disables what is taken rather than discovering it.** A login
already attached to somebody else is shown greyed with the name that holds it.
Offering it and letting Postgres refuse would be a constraint violation where an
explanation belongs; the route still translates 23505 into a sentence, because a
picker built from stale data can always lose the race.

**Linking is audited.** Who may log hours as whom is a permission, and it is the
one that decides whose salary a project's margin is charged with.

**Verified end to end, then removed.** Two probe people, a probe project and a
probe employee login: the column renders "not linked", the footer counts how
many cannot fill in their own hours, linking succeeds and is audited, linking
the same login twice is refused with a sentence, the employee then sees the form
and the project, and the owner still correctly sees "not linked". Every probe
row deleted afterwards — zero people, zero projects, zero time entries, the two
real users.

One probe result read as a failure and was not: with no projects in the
database, the employee's page showed neither the form nor the not-linked
message, because `Timesheet` renders "no open projects to log against" instead.
Re-running with a project present showed the form. Worth recording because the
first reading was "the employee page is broken", and acting on that would have
meant fixing something that was right.

---

## 90. A permission check that had never once run

`loadProject` decided whether a reader may see labour cost like this:

```ts
// RLS answers a viewer with an error, not an empty list, so this tells
// "nobody has logged time" apart from "you are not allowed to know".
const canSeeLabour = !timeRes.error && !peopleRes.error;
```

The comment states the premise plainly, and the premise is false. A select
blocked by Row Level Security comes back **HTTP 200 with `[]` and no error at
all** — verified with a real viewer token against the live database, on a table
holding a row that reader must not see.

So the guard never fired, for anybody, since the day it was written. A viewer
opening a project got `people` as an empty list, labour computed from nobody, a
labour cost of zero, and a **net profit identical to the gross one** — labelled
"Net profit", hinted "No time logged — same as gross", on a project with twenty
hours logged against it. Verified: before the fix a viewer saw exactly that on a
project carrying $2,400 of labour.

That is the confident zero this system refuses everywhere else. It is worse than
the payroll leak of decision 41, which showed a number that was true to somebody
who should not have seen it; this showed a number that was **false to everybody**
and looked authoritative.

**Why an empty list can never decide a permission.** "There is nothing here" and
"you may not see what is here" are indistinguishable from the result — that is
precisely what RLS is for. Only the capability can tell them apart. `loadProject`
now takes `canSeeCompensation` from the caller, which passes
`sessionCan(session, 'see_compensation')` — the same rule
`can_see_compensation()` enforces in Postgres, with the RBAC integration test
already asserting the two agree.

**It defaults to false.** A caller that forgets gets "not visible to you" rather
than a net profit computed from a labour cost of zero. A permission argument
that fails open is not a permission argument.

**The platform behaviour is now pinned by a test** in
`tests/rbac.integration.test.ts`, asserting that a viewer's blocked read returns
an empty list and no error. It is not testing our code — it is testing the
assumption our code is entitled to make, so that the next person tempted to
write `!res.error` as a permission check finds it written down. It also fails
loudly if Supabase ever changes its mind, which would silently re-open this in
the other direction.

**How it was found.** Not by a test, and not by reading the code for bugs. It
surfaced while checking whether labour could be added to the portfolio roll-up:
the visibility rule had to be reused, so it had to be understood, and the comment
explaining it did not match anything else seen this session — every blocked read
tested for the timesheet work had come back as an empty list. Ten minutes with a
real viewer token settled it.

The grep for other guards of the same shape found exactly one, this one.

---

## 91. Labour in the roll-up, and a project you can correct

Two backlog items, taken together because they sit on the same critical path:
AHN is about to enter project data for the first time, and both the reading and
the writing of it were incomplete.

### Labour reaches the §16 roll-up

`computeProjectLabour` had been wired into the project *detail* page since Phase
2, but `loadProjectPortfolio` never loaded a time entry — so the projects list
and the roll-up built in decision 87 both showed a business unit's margin with
its largest cost missing. Now that hours can actually be logged (decision 88),
that gap was the difference between a roll-up and a roll-up worth reading.

**Gross profit deliberately still excludes labour.** The new figures are two
extra columns — `Labour` and `After labour` — not a redefinition. A margin
somebody quoted last month must not change value because a new cost started
being tracked, and a test asserts gross profit is identical with and without a
labour lookup.

**`rollUpBy` takes the lookup as an optional argument**, so every existing
caller keeps its exact behaviour and gets `labourUsdMinor: null`. Null is the
point: **"not counted" and "counted as nothing" are different claims**, and the
type makes the distinction impossible to lose. `ProjectPortfolio.labourByProject`
is likewise `Map | null` — null for a reader who may not see compensation, an
empty map for one who may and finds no hours.

**For a reader without compensation access the columns are removed, not
dashed.** A column of em-dashes invites the assumption that the number is zero,
which is exactly what it is not; the callout underneath says the role does not
include seeing what people cost. Verified live: a viewer's roll-up has no labour
column and still reconciles to the portfolio total.

**Software allocation stays absent, and the page now says why.** It is the one
remaining 🟡, and it is not an engineering gap: allocating a subscription across
projects needs a basis — headcount, hours, an explicit tag — and any of them
would flatter or punish projects arbitrarily. That is AHN's decision, so the
caveat states it rather than inventing one.

### Editing a project

Projects were create-and-attribute only. A typo in a name, a project that
finished, a contract value that arrived a week later — each needed the SQL
console, on the one table AHN is about to fill in by hand. **Data entry that
cannot be corrected is data entry nobody starts.**

`PATCH /api/projects/[id]` runs on the caller's own session, so
`p_projects_write` and migration 0025's unit scoping are the boundary. Every
field that moves is audited: a contract value moves the unbilled total, a status
moves a project in and out of the active roll-up.

**`business_unit_id` is deliberately not editable.** Moving a project between
units silently restates two units' historical margins — and because 0025 scopes
write access *by unit*, a department lead could otherwise move a project into
their own unit and then edit it. That is a transfer, not a correction, and it
belongs to whoever can see the whole picture.

**Blank means null, never zero.** Spec §12 wants contracted and invoiced
revenue; neither exists in a bank feed, and "nobody has told us" is a different
claim from "nothing was contracted". The inputs say `not known` rather than `0`.

Verified live: an owner renamed a project, closed it and set a $50,000 contract
in one call — three audit rows, the money one rendered as `$50,000.00`. An end
date before the start date was refused. A viewer got 403 and the other project
was untouched. Every probe row removed afterwards.

---

## 92. Commitments that come round again

Spec §18 is about knowing what leaves the bank before it does, and almost every
example it gives is recurring: payroll, VEEM payments, legal retainers,
accounting fees, taxes, software renewals. `is_recurring` recorded that a
commitment repeated and nothing ever acted on it, so "cash after commitments"
only ever saw the rows somebody had typed. Next month's payroll was invisible
until the day it was entered — which is the opposite of what §18 asks for.

**A cadence, not a boolean.** "It recurs" says a thing repeats without saying
when, which is not enough to generate anything. `recurrence` is
monthly/quarterly/annual; existing rows keep their old flag and get a null
cadence, meaning "recurring, cadence unknown". Nothing is generated for them,
because inventing a monthly rhythm on their behalf would put money in the
forecast that nobody committed to.

**The walk starts at the template's own date, not at today.** Rent due on the
1st must keep landing on the 1st; counting forward from "now" would drift the
day of the month every time the job ran, and a commitment that wanders the
calendar cannot be reconciled against the payment that settles it. `addMonths`
clamps a 31st to the last day of a shorter month, which is what a monthly
commitment does in reality.

**Ninety days, and no further.** That covers the quarter a CFO is actually
looking at. Generating years ahead would fill the aging buckets with rows nobody
has committed to and make "overdue" meaningless the first time a template's
amount changed.

**Idempotent twice over.** The missing-instance calculation only asks for dates
that do not already exist, and a unique index on (generated_from_id, due_on)
refuses a duplicate even if two runs overlap. A job that runs daily must not
create thirty copies of March's rent.

**The template's own due date counts as already generated.** Without that, the
first run duplicates it: the walk starts at that date, and the template is not
in `existing` because nothing generated it. The result would be two identical
rows for this month's payroll — caught by reading the first live run rather than
by a test.

**A generated instance is never itself a template**, or each month's row would
start generating its own children and the table would grow geometrically.

**Generation runs before the alert sweep**, in the same daily job, so a newly
created commitment is alerted on the same day rather than the next.

Verified live: a monthly $18,500 payroll template dated 3 September produced
3 October and 3 November on the first run, and `0 created, 1 alreadyThere` on
the second. The obligations page moved from $1,602.67 to $38,602.67 owed out
inside thirty days, and cash-after-commitments from $76,257.90 to $39,257.90 —
which is the whole point of §18. Every probe row removed afterwards.

### Two hours lost to a port

Worth recording because it will happen again. Every page and API route appeared
to 404 or redirect to `/sign-in`, through a clean rebuild and a deleted `.next`.
Nothing was wrong: **port 3000 on this machine belongs to another of AHN's
projects**, `AHN_MigrateToolSHOPLINE`, whose Next dev server was already bound —
so `next start` failed with EADDRINUSE and every request was answered by that
application instead.

The tell was there and was misread: this app redirects an anonymous visitor to
`/login`, and the responses were redirecting to `/sign-in`. A route that 404s is
ambiguous; a redirect to a path this codebase does not contain is not.

The lesson is the same one as decision 90 in a different costume: **an
unexpected empty answer is not evidence about your own code until you have
confirmed who answered.** Local verification now runs on port 3777, and the
smoke script already took a base URL for exactly this reason.

---

## 93. Gross margin, which the taxonomy could already answer

Spec §11 asks the simulator for "a desired **gross or net** profit margin". Only
net was built, and the backlog explained why: a gross margin needs a
cost-of-delivery classification the §7 taxonomy does not provide.

That note was wrong. `cost_of_delivery` has been a category in the taxonomy
since the categoriser was written — `/explain` has been reporting against it all
along. The blocker was a stale sentence in a document, and it had been sitting
there long enough to look like a fact.

**Same equation, different divisor.** `requiredRevenueForMargin` was already
generic: it takes an expense figure. Net divides into everything the company
spends; gross only into what delivering the work costs. On the test figures a
40% target asks for $1,333,333 of revenue on a net basis and $333,333 on a
gross one — a four-fold difference, and quoting one when you meant the other is
a planning error rather than a rounding one. So the basis is now chosen in the
interface rather than assumed by the code.

**Delivery cost is null when nothing carries the category, never zero.** Zero
would mean delivering the work is free, and a gross target measured against it
returns a required revenue of nothing at all — a confident, tiny, wrong number.
The mode refuses instead and says what to do: categorise the direct costs, or
use a net margin.

**The two averages describe the same window.** Delivery cost is averaged over
exactly the months the burn rate sampled. A gross margin computed over a longer
period than the net one would quietly be comparing different things.

**One stated assumption.** Delivery cost is grown at the same rate as total
expense, because nothing in the ledger says whether it scales with revenue or
with headcount. That is the assumption the net projection already makes, so the
two modes stay comparable — and it is written down rather than buried.

---

## What was NOT changed

The plan's week-1 boundary held. Subscription intelligence (spec §8) has since been
built as the first Phase 2 item — see decisions 42-44. Phase 2 has since gone
further than that list: project P&L, time tracking and loaded labour cost, the
revenue simulator, budgets, obligations, the full 7-role RBAC, and the
deterministic half of the AI CFO layer are all built (decisions 45-82), and
exchange rates now refresh themselves daily, and Slack answers questions.

What remains untouched is the *interpretation* half of §20 — the model that reads
`explain.ts` and writes the sentence a CFO would say. Plan §11 gates it on 2-3
months of clean data and the ledger holds 135 sandbox transactions, so the honest
position is that the input does not exist yet, not that the work is hard.

Two things were done to make those cheap to add later, at no cost to week 1:
`is_subscription` and `is_recurring` are populated on every transaction from day one,
and categories already follow the spec §7 taxonomy. When subscription intelligence
starts, the history it needs is already there rather than starting from zero.
