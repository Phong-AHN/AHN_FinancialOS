# My Cash Pilot — development timeline

What was built, on which day, and what proved it worked. Dates are commit dates
from `git log`; the detail under each is the work that commit carried.

This file is a record, not a plan. For what is still outstanding see
[TODO.md](TODO.md); for why a thing was built the way it was, see
[DECISIONS.md](DECISIONS.md).

---

## 27 Aug 2026 — the system goes up

First commit. The application deployed to Vercel, the scheduler worker moved to
Railway, Stripe connected, and the server region moved to Tokyo so "today"
resolves correctly for a Vietnamese business day.

## 3–11 Sep 2026 — phase 2, legal pages, QuickBooks production

Phase 2 closed. The privacy policy and EULA went up as public pages, because
Intuit and Plaid both require them before an app may touch production data.
QuickBooks production access was applied for and granted (`ea207fe`,
11 Sep) — token refresh with rotation, revocation on disconnect, CDC polling,
`intuit_tid` captured on every failure, and a guard that refuses to connect a
second company while another is still on record.

## 16 Sep 2026 — three commits, the heaviest day

**`f29c2c9` — screenshot import, second pass** (28 files)

Thirteen defects fixed in the VietinBank screenshot reader. The one that
mattered most: tall scrolling captures were shrunk to fit a 2576px long edge and
arrived 377px wide, digits a few pixels high. Images are now cut into
overlapping tiles that respect both the long-edge and the 4784 visual-token
limit. Also: each row carries its own currency instead of the account's, amounts
display in major units, typed times are normalised, Vercel's HTML error pages
stop surfacing as "Unexpected token '<'", and the model that actually answered
is recorded per row.

Verified: 776 tests, clean build, 9/9 runtime probe against the commit route
with a throwaway owner and account, all temporary data removed.

**`1f20403` — production readiness** (60 files, ~22k lines)

- Product renamed **AHN Financial OS → My Cash Pilot** across code, docs and
  legal pages.
- Plaid production application answered end to end: industry, geography,
  products (Transactions + Balance only), use cases, beneficial ownership, and
  the security questionnaire.
- Three policy documents written and rendered to PDF for Plaid: Information
  Security, Access Control, Data Retention and Disposal.
- MFA evidence produced by driving a headless browser over CDP against throwaway
  accounts — real screens, not mock-ups — and assembled into a PDF.
- `/item/remove` now called when a Plaid connection is disconnected. Until then
  the Item stayed live and billable at Plaid while the portal reported success.
- Stripe revenue rules: event-ticket and consulting categories, and the
  processor's own `balance_transaction.type` trusted over guessing from wording,
  which is what fixed two refunds sitting in the uncategorised queue.

**`d34a4a1` — two-factor and sign-in** (8 files)

A `/security` page where a person changes their own password and moves their
authenticator to a new phone — the replacement is enrolled and verified *before*
the old factor is removed, so a failure never locks anybody out. An owner can
reset somebody else's authenticator from the access page, behind
`manage_people`, with the reset written to the audit log.

Migration `0042` relaxed a database trigger that froze `users.email`: the app
email may now change, but only to match the login it belongs to.

Verified: 12/12 runtime probe — a viewer refused, a signed-out request refused,
an owner refused their own reset, the real reset removing exactly one factor.

## 18 Sep 2026 — `1698920` — the dashboard answers back

A total row on "Where the cash is" that sums **every** account rather than the
eight shown, and a CSV export that takes the whole filtered set rather than the
page on screen. Excel opens it directly: BOM, CRLF, and signed plain numbers.

A probe caught a real defect before it shipped: the spreadsheet-injection guard
was prefixing every negative amount with an apostrophe, so Excel read each
outflow as text and the column summed to nothing.

## 21 Sep 2026 — Railway serverless (committed 28 Sep)

Railway's free plan requires serverless, which sleeps a service after five
minutes without outbound traffic and wakes it only on traffic *arriving*. The
scheduler sends and never receives, so under that rule it would sleep between
syncs and never wake — silently.

The worker gained a `--once` mode: Railway starts it on a cron schedule, it does
what is due and exits. 8/8 tests against a recording stub, no real alert or
digest sent.

The same investigation found the worker had **never run**: no root directory, no
environment variables, and the last sync was a manual one on 18 Sep.

## 19 Sep 2026 — where the numbers come from

A full audit of every dashboard figure, read from the production database:
formula, source, current value, and where to correct it. Published as a shared
page, later rewritten in English with a section on how to *find* a wrong figure
— the variance column, and the four patterns it shows.

Findings: 82% of the cash figure rested on three accounts whose provider balance
its own transactions could not support, one holding $137,280 with no
transactions at all; runway read 260 months because payroll was not in the
ledger; a credit card was typed as a checking account and counted as cash.

## 28 Sep 2026 — `41cd888` — correcting the ledger

The gap the audit exposed: an account could be created and never corrected.
Now the accounts page can change an account's type, name, opening balance,
whether it counts as cash, and whether it is still in use — each change written
to the audit log with old value, new value, who and why. Retired accounts stay
listed in their own section, so switching one off is not a one-way door.

Verified: 16/16 runtime probe, including that a QuickBooks balance cannot be
overwritten locally and that an unchanged save writes nothing.

---

## Still open

- `ANTHROPIC_API_KEY` is not set, so the screenshot reader has never run against
  the real sample image.
- Payroll is not in the ledger, so burn and runway remain understated.
- `fx_rates` is empty; a VND account created before a rate exists converts to $0.
- Plaid remains on sandbox keys pending production approval.
