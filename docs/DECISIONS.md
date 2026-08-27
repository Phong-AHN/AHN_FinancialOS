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

## What was NOT changed

The plan's scope boundary held. No project P&L, no events P&L, no subscription
intelligence, no time tracking, no revenue simulator, no budget vs. actual, no AI CFO
layer, no 7-role RBAC — all Phase 2/3 per plan §8, and all still requiring their own
tables.

Two things were done to make those cheap to add later, at no cost to week 1:
`is_subscription` and `is_recurring` are populated on every transaction from day one,
and categories already follow the spec §7 taxonomy. When subscription intelligence
starts, the history it needs is already there rather than starting from zero.
