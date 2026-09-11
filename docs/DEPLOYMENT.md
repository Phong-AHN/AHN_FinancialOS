# Deployment

Two pieces, deployed separately:

| | Where | What it does |
|---|---|---|
| **The app** | Vercel | Next.js — dashboard, API routes, `/api/cron/*` endpoints |
| **The scheduler** | Railway | Calls those cron endpoints on a schedule |

## Why the scheduler is not on Vercel

Vercel's Hobby plan allows **one cron run per day**:

> Hobby accounts are limited to daily cron jobs. This cron expression
> (`*/10 * * * *`) would run more than once per day.

The sync needs to run every ten minutes, or "every dollar, within a few minutes"
is not true. The schedule therefore lives in
[`worker/index.mjs`](../worker/index.mjs), deployed separately.

Nothing else changed. The `/api/cron/*` endpoints are identical and still
guarded by `CRON_SECRET`; the worker is only a caller.

**There is no `vercel.json`.** It held nothing but the crons, and Vercel's schema
rejects unknown keys (`should NOT have additional property "comment"`) so the
explanation could not live there either. Everything else it might have carried is
already elsewhere: `maxDuration` is declared per route with
`export const maxDuration = 60`, and the security headers are in
`next.config.mjs`.

### Region: put the app next to the database

`vercel.json` pins the deployment to **`hnd1` (Tokyo)** because the Supabase
project lives in **`aws-0-ap-northeast-1`**, which is also Tokyo. This is not a
preference. It is the single largest thing affecting how fast the app feels.

Measured from Vietnam against the Tokyo database, one round trip costs about
**145ms** — an empty `select * from companies` takes that long, and so does
anything else, because the time is distance, not work. A page that makes four
sequential round trips spends 580ms waiting on the network and a few
milliseconds computing.

Vercel defaults to `iad1` (Washington DC). Left alone, every query would travel
Washington → Tokyo → Washington, and every page would travel Vietnam →
Washington on top of that. The app would be slower deployed than it is running
on a laptop in Hanoi.

With the app in Tokyo the shape inverts:

| | Server in Washington (default) | Server in Tokyo (`hnd1`) |
|---|---|---|
| Server → database, per query | ~170ms | ~1–5ms |
| Person → server, per page | ~230ms | ~60ms |
| A page making 4 queries | ~910ms | ~80ms |

The queries stop mattering; only the one hop from the reader to the server does.

**Set the Railway worker to Tokyo as well** (Settings → Region). It calls the
app's own `/api/cron/*` endpoints, so a worker on another continent pays the
same tax on every scheduled run.

If AHN later moves the Supabase project closer to Vietnam — Singapore
(`ap-southeast-1`) is the nearest region — move the Vercel region to `sin1` in
the same change. The rule is that the app and the database share a region; which
region they share matters far less.

## Moving back to Vercel Cron on a Pro plan

Add the `crons` block to the existing `vercel.json` — keep the `regions`
setting — and stop the Railway service:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["hnd1"],
  "crons": [
    { "path": "/api/cron/sync", "schedule": "*/10 * * * *" },
    { "path": "/api/cron/digest?period=daily", "schedule": "0 2 * * *" },
    { "path": "/api/cron/digest?period=weekly", "schedule": "0 2 * * 1" },
    { "path": "/api/cron/price-increases", "schedule": "0 3 * * *" },
    { "path": "/api/cron/exchange-rates", "schedule": "0 1 * * *" }
  ]
}
```

The exchange-rate job runs an **hour before** the digest, not after. Every USD
figure the digest reports is converted through that table, so refreshing
afterwards would mean the morning summary always quotes yesterday's rate. It is
also kept off the ten-minute sync tick because Vietcombank asks for no more than
one request every five minutes, and a feed that gets AHN rate-limited is worse
than one that runs once a day.

The price-increase sweep is deliberately its own daily job rather than part of
the sync. It re-reads three years of outflows to rebuild the recurring-charge
picture, and a price changes monthly at most; folding it into a ten-minute tick
would spend most of that tick's 60-second budget rediscovering the same answer,
and a slow run would take the ordinary money-in and money-out alerts down with
it. It deduplicates by vendor and change date, so running once a day still
announces every rise exactly once.

Vercel cron schedules are **UTC and not configurable**, so `0 2 * * *` is 09:00
in Vietnam. That is the one thing the Railway worker does better: it takes a `TZ`
and fires on local time.

The worker is a plain interval loop rather than Railway's own cron feature, so it
runs the same way on Railway, Render, Fly or a VPS. No provider's cron syntax,
quota or minimum interval is baked in.

---

## 1. Deploy the app to Vercel

Set these in **Project Settings → Environment Variables**. `.env.local` is not
uploaded — Vercel needs its own copy.

This list is checked by `tests/deploy-env.test.ts`, which runs on every
`npm test` — it needs no database. It exists because this page went stale once:
`STRIPE_SECRET_KEY` was missing while Stripe was a live, syncing integration,
and a deployment following it would have had a silently broken sync and no error
to point at.

### Required — the app will not work without these

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
ENCRYPTION_KEY             same value the tokens were encrypted with, or every
                           stored OAuth token becomes unreadable
CRON_SECRET                without it /api/cron/* refuses to run at all
NEXT_PUBLIC_APP_URL        https://your-app.vercel.app  ← alert deep links use this
BUSINESS_TIME_ZONE         Asia/Ho_Chi_Minh. Decides what "today" means; left
                           unset the app falls back to UTC and names the wrong
                           day for the first seven hours of every Vietnamese
                           day (decision 84). Match the worker's TZ.
```

### Integrations — set the ones you actually use

```
QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_ENVIRONMENT / QBO_REDIRECT_URI
PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV
STRIPE_SECRET_KEY          an sk_test_ key is treated as sandbox and its rows
                           never raise an alert (decision 98)
VEEM_CLIENT_ID / VEEM_CLIENT_SECRET / VEEM_ACCOUNT_ID / VEEM_API_BASE
VEEM_FUNDING_METHOD_ID     which account pays outgoing payroll. Optional — Veem
VEEM_FUNDING_METHOD_TYPE   uses the default when unset. List them with
                           GET /veem/v1.2/account/fundingMethods
VIETINBANK_CLIENT_ID / VIETINBANK_CLIENT_SECRET / VIETINBANK_ACCOUNT_NUMBER
VIETINBANK_PROVIDER_ID / VIETINBANK_MERCHANT_ID / VIETINBANK_ENV
VIETINBANK_API_BASE / VIETINBANK_ACCOUNT_TYPE / VIETINBANK_CHANNEL / VIETINBANK_MODEL
FINVERSE_CLIENT_ID / FINVERSE_CLIENT_SECRET / FINVERSE_ENV / FINVERSE_REDIRECT_URI
```

`QBO_ENVIRONMENT` and `PLAID_ENV` are not cosmetic: while either says `sandbox`,
that source's rows are excluded from alerting, so nobody is paged about test
money. They start alerting the moment the value becomes `production`.

### Alerting — each channel is optional and silently skipped when unset

```
SLACK_BOT_TOKEN
SLACK_DEFAULT_CHANNEL      "#ahn-finance-alerts"   ← quote it, see below
SLACK_CHANNEL_CRITICAL / SLACK_CHANNEL_WARNING / SLACK_CHANNEL_DIGEST
SLACK_WEBHOOK_URL          legacy fallback; prefer the bot token
SLACK_SIGNING_SECRET       required for /ahn slash commands. Without it the
                           endpoint refuses every request rather than answering
                           unauthenticated
RESEND_API_KEY / ALERT_EMAIL_FROM / ALERT_EMAIL_TO
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / ALERT_SMS_TO
```

> **Quote every channel name.** An unquoted value starting with `#` is read as a
> comment and arrives empty, which silently drops the app back to the incoming
> webhook — one channel for everything, and messages the bot cannot delete. This
> cost real debugging time once already (decision 35).

### Not needed on Vercel

`SUPABASE_DB_URL` is read only by `scripts/db-push.mjs` and the other local
tooling. It is the direct Postgres connection string; the deployed app never
uses it.

`ENCRYPTION_KEY` must be **the same value** as the one the tokens were encrypted
with, or every stored OAuth token becomes unreadable and the integrations have to
be reconnected.

After deploying, update the redirect URI on the Intuit app to the production URL
and set `QBO_REDIRECT_URI` to match.

### The five URLs Intuit asks for

Intuit will not issue **production** keys until the app settings are complete.
Five of the fields are URLs this repository serves. Replace `APP` with the
production origin (`https://ahn-financial-os.vercel.app`, or the custom domain
if one is set) and paste them in exactly.

| Intuit field | Value | What it does |
|---|---|---|
| Host domain | `APP` without the scheme | Must be the origin the other URLs sit on, or Intuit rejects them. |
| Launch URL | `APP/launch` | Where QuickBooks sends someone who clicks the app tile inside their company file. Signed in, it lands on Integrations; signed out, on the sign-in page. |
| Disconnect URL | `APP/disconnect` | Where QuickBooks sends someone who has just disconnected the app from inside QuickBooks. A confirmation page — **it deliberately changes nothing**, see below. |
| Connect / Reconnect URL | `APP/api/integrations/quickbooks/connect` | Starts the OAuth flow. Same route the Connect button uses. |
| EULA link | `APP/eula` | End-User License Agreement. |
| Support (if asked) | `APP/support` | How to reach the team, and what to include. Public. |
| Privacy policy link | `APP/privacy` | Privacy policy. |

And separately, under **Keys & OAuth**:

| Redirect URI | `APP/api/integrations/quickbooks/callback` |
|---|---|

All six are reachable **without signing in**, because the reviewer opening them
is not an AHN user. `tests/app-urls.test.ts` fails if any of them moves inside
the authenticated route group.

**Why the Disconnect URL does not disconnect anything.** Intuit reaches it with
an ordinary browser redirect: nothing is signed, and the URL is written down in
the app settings and in this file. If loading that page revoked the tokens, then
any crawler, link preview or prefetch could sever AHN's accounting connection
with a GET. There is also nothing urgent to do — by the time anybody lands
there, Intuit has already revoked the grant at their end. Clearing AHN's stored
copy is housekeeping, and it happens on the Integrations page, where a signed-in
owner does it deliberately and the token is revoked at Intuit first.

### Switching QuickBooks from the sandbox to the real company

**Order matters.** Steps 3 and 4 must happen before step 6, and the application
enforces it: the OAuth callback refuses to connect a second QuickBooks company
while another is on record.

Why: QuickBooks numbers every company's records from 1, and this system keys a
transaction as `Purchase:123` with no company in the key. With the sandbox rows
still held, the real company's `Purchase:123` would be skipped as a duplicate of
the fake one and its bank accounts merged into the sandbox's — silently.

1. **Deploy first.** Intuit does not accept `localhost` as a production redirect
   URI, so the real company can only be connected through the deployed app, on
   the domain entered as *Host domain* in the Intuit app settings. Commit and
   push, then deploy (section 1 above).
2. **Sign in to the deployed app** and set up your authenticator.
3. **Disconnect the sandbox company** — Integrations → QuickBooks → Disconnect —
   while the sandbox keys are still configured, so its grant is revoked at
   Intuit.
4. **Clear the sandbox data** (runs locally against the same database):
   ```
   node scripts/purge-quickbooks-sandbox.mjs --realm 9341457793093583            # shows what goes
   node scripts/purge-quickbooks-sandbox.mjs --realm 9341457793093583 --confirm
   ```
   It removes the sandbox company's transactions, invoices, bills and accounts,
   its integration row, and counterparties nothing refers to afterwards. It
   refuses if the company is still connected or if a second company is on
   record.
5. **Switch the keys** — in Vercel *and* in `.env.local`:
   | Variable | Value |
   |---|---|
   | `QBO_ENVIRONMENT` | `production` |
   | `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` | Intuit portal → your app → **Production** → Keys & credentials |
   | `QBO_REDIRECT_URI` | `https://<your domain>/api/integrations/quickbooks/callback` |
   | `NEXT_PUBLIC_APP_URL` | `https://<your domain>` |

   Register the same redirect URI under **Production** redirect URIs in the
   Intuit portal — the sandbox list is separate. Redeploy: variables are read
   when the server starts.

   `.env.local` must change too. Local and deployed share one database; a
   local "Sync now" with sandbox settings would send the production tokens to
   the sandbox API, fail, and mark the real connection as needing reconnection.
6. **Connect.** Integrations → Connect QuickBooks → sign in as a user who is an
   **admin of the company's QuickBooks** → choose the company → Connect. The
   first sync reads six months of history; transactions older than
   `ALERT_MAX_AGE_DAYS` (3) are recorded without sending alerts.
7. **Check it.** The QuickBooks card shows Connected and a count of real
   transactions; *Recent provider errors* is empty; one account's balance on
   `/accounts` matches QuickBooks; invoices and bills appear on `/obligations`.

Until Plaid and Stripe are also on production keys, the cash figures mix real
QuickBooks data with simulated bank and payment data.

### Two-factor sign-in is mandatory

Every account signs in with a password (or email link) **and** a six-digit code
from an authenticator app. There is no opt-out.

- **The first time anybody signs in after this ships — including the owner —
  they are taken to set up an authenticator.** It takes about a minute: scan a
  QR code with Google Authenticator, Microsoft Authenticator, 1Password or Authy,
  and type the code it shows.
- The rule is enforced by the database (migration 0040), not by the pages. A
  password on its own reads nothing, through the app or straight through the
  Supabase API.
- The scheduler, the OAuth callback's writes and the Slack commands use their
  own secrets and are unaffected. **Turn on two-factor for the Slack workspace
  too** (Slack admin → Authentication): a Slack account that can run `/ahn cash`
  is otherwise a way to read the cash position on one factor.

**Somebody who loses their phone** is locked out until an administrator removes
their authenticator:

```
node scripts/mfa-reset.mjs person@example.com            # shows what would go
node scripts/mfa-reset.mjs person@example.com --confirm  # removes it
```

Confirm who is asking **out of band** first — a call to a number already on
file, or in person. An email saying "I lost my phone" is exactly what somebody
holding a phished password would send. The script writes an audit record. It
does not end sessions already open; if an account may be compromised rather
than locked out, also change its password in the Supabase dashboard.

**The smoke test** can no longer sign in with a password alone:

```
npm run smoke -- --ephemeral http://localhost:3777
```

creates a temporary owner with its own authenticator, checks every page, and
deletes it.

### Vulnerability checks run on their own

`.github/workflows/security.yml` runs `npm audit` on production dependencies
(failing on high or critical), the typecheck and the full unit suite on every
push, every pull request, and **every Monday** whether or not anything changed.
`.github/dependabot.yml` opens update pull requests weekly. Neither needs a
secret. Both start working once pushed to GitHub.

### Answers to Intuit's behavioural questions

The review form asks how the app behaves, not only what it connects to. These
answers describe what the code does; `tests/retry.test.ts` and
`tests/reauth.integration.test.ts` hold them to it.

| Question | Answer |
|---|---|
| How does your app interact with Intuit product data? | **Reads only.** One call, a GET to `/v3/company/{realmId}/query`. Nothing writes or deletes. |
| How often do you refresh access tokens? | **Only when they expire.** The stored expiry is checked first and the token reused if more than 60s of life remains — roughly hourly in practice, driven by a 10-minute sync against 1-hour tokens. |
| Do you retry failed authorization requests? | **Yes, when retrying can work.** Three attempts with exponential backoff and full jitter for network faults, 429 and 5xx. A dead refresh token is **not** retried. |
| Do you ask customers to reconnect after an auth error? | **Yes.** A permanent auth failure sets the connection to `reauth_required`, shows a reconnect prompt on the Integrations page, and sends a critical alert on every configured channel — once, not on every tick. |
| Handles **expired access tokens**? | **Yes**, two ways. Proactively from the stored expiry with a 60s cushion; and reactively — a 401 forces one refresh and one retry, because Intuit can invalidate a token before its stated expiry. Both paths proved against the live Intuit API (`tests/reactive-refresh.integration.test.ts`). |
| Handles **expired refresh tokens**? | **Yes.** Intuit's 100-day expiry returns `invalid_grant`, which is classified as a dead grant: `reauth_required`, reconnect prompt, one alert. Never retried. |
| Handles **invalid grant** errors? | **Yes**, explicitly and by name. Verified against Intuit's live token endpoint in `tests/reauth.integration.test.ts`. |
| Handles **CSRF** errors? | **Yes.** 192-bit `state` in an httpOnly, SameSite=Lax, 10-minute single-use cookie, compared in constant time. A callback with a missing, empty or mismatched `state` is refused before the code is exchanged. |
| Relies on the **OAuth Playground** or other offline tools for tokens? | **No.** Every grant comes from the in-app authorization-code flow (`/api/integrations/quickbooks/connect` → Intuit consent → `/callback`), and is refreshed with the refresh token that flow issued. No token is read from an env var or pasted in. `tests/app-urls.test.ts` fails if one ever is. |
| Ever had a **security breach** requiring notification? | **Yours to answer** — a fact about the company, not the code. Nothing in this system's history is a notifiable breach. Two passwords were typed into an AI chat during development; that is a credential exposure to rotate before submitting, not a breach of anybody's data. |
| A **security team** that regularly assesses vulnerabilities? | **Yours to answer**, because it is a statement about people. What the code does on its own: a CI workflow runs `npm audit` (fails on high/critical), typecheck and the full test suite on every push and **every Monday**; Dependabot opens update PRs weekly; every permission is tested against the live database with two-factor sessions. Answer Yes only if somebody at AHN owns reading those results. |
| Client ID / secret **stored securely**? | **Yes.** Environment variables only, never in source. `.env.local` and `.env.production` are git-ignored and have never been committed. Nothing secret is logged. Verified in the built output: none of the ten server-only secrets, `QBO_CLIENT_SECRET` included, appears anywhere in the 87 files sent to a browser. The client **ID** appears in the OAuth authorise URL by design. |
| Uses **multi-factor authentication**? | **Yes — mandatory for every account.** Password or email link, then a TOTP code from an authenticator app. Enforced by the database (migration 0040): every table carries a restrictive policy requiring `aal2`, so a stolen password reads nothing even straight against the Supabase API. |
| Uses **Captcha**? | **No.** Access is invite-only, mandatory two-factor stops a guessed or phished password from reaching data, and Supabase Auth rate-limits sign-in attempts. A captcha would add friction without closing a gap those leave open. |
| Uses **WebSocket**? | **No.** Nothing subscribes to Supabase Realtime or opens a socket. The Content-Security-Policy no longer allows `wss:` at all, so none could be opened. |
| Is Intuit data used by or shown to **anyone other than that customer**? | **No.** It is shown only to AHN's own staff, each with a named two-factor login, and each table is further restricted by role in the database. Alerts go only to AHN's own Slack workspace, email addresses and phone numbers, through Slack, Resend and Twilio as delivery services — named in the privacy policy. Nothing is sold, shared, or sent to any AI service. |
| Which **QuickBooks Online versions**? | **Simple Start, Essentials, Plus and Advanced.** Every entity read exists in all four except Bill and BillPayment, which Simple Start lacks; those are skipped for a Simple Start company instead of failing its sync. Run against the live sandbox, which is **QuickBooks Online Plus**. |
| Handles users **gaining or losing** version-specific features? | **Yes.** A feature the subscription lacks (Intuit code 5030) is classified as `unavailable`: skipped, not retried, not reported as a fault, and asked for again once a day — so a downgrade never breaks the sync and an upgrade is picked up within a day, with its history. Data already imported is kept either way. |
| Uses **multicurrency / sales tax**? | **None of the above.** Sales tax is not read — cash is taken from `TotalAmt`, which already includes it. Amounts are stored in each row's own `CurrencyRef`, but no multicurrency QuickBooks company has been tested, and the form asks only for features "verified and thoroughly tested". Multicurrency cannot be switched off once enabled, so it was not enabled on the sandbox to find out. |
| Uses **webhooks**? | **No.** CDC every 10 minutes covers the same need, and Intuit recommends CDC for staying in sync. A webhook would add a public, unauthenticated-until-verified POST endpoint to a finance system for a latency gain nobody here needs. |
| Uses the **CDC operation**? | **Yes.** Every incremental sync. It is what catches deletions — a transaction deleted in QuickBooks is removed from the ledger, an invoice or bill deleted there is voided — which the old per-entity queries could not see. Verified against the live API: the response shape, and that CDC names every row exactly as the query path did, so switching paths imports nothing twice. |
| **Why** CDC? | **Querying specific entities doesn't give me the information I need** — a query never returns a deleted object, so deletions could not be seen — **and Other:** *"Efficiency: one CDC request returns changes for all six entities we read, replacing one query per entity, so an incremental sync is two API calls in total. It also lets a sync that missed runs catch up on up to 29 days of changes without re-reading history."* Not "webhooks don't give me the information": they would, and saying otherwise is untrue. |
| How often is CDC **polled**? | **Every 10 minutes**, two calls per poll (~290 a day per company). Set by `SYNC_INTERVAL_MINUTES`. Intuit's reference pattern is webhooks plus a periodic (e.g. nightly) CDC call; this app uses CDC alone, more often, because it has no webhook endpoint. |
| Tested against API errors, **including syntax and validation**? | **Yes.** Against the live API: a query that does not parse (400, code 4000) and one naming a field that does not exist (400, code 4001) are both classified `rejected`, **sent once and never retried**, and logged with Intuit's detail. Auth, rate-limit, outage, edition (5030) and CSRF failures are tested too. `tests/qbo-errors.integration.test.ts`, `tests/retry.test.ts`. |
| Captures **`intuit_tid`**? | **Yes**, from every QuickBooks response that is classified as an error — query, CDC, token and revoke. It is stored in the error log, appended to `last_error` on the Integrations card, and linked to a pre-filled support email. Verified: Intuit sends it on successes and on token-endpoint failures as well. |
| Keeps **error logs** that can be shared? | **Yes.** Table `integration_errors` (migration 0039): time, operation, classification, HTTP status, Intuit fault code, `intuit_tid`, message. Credentials are redacted before a row is written; rows cannot be edited or deleted through the app. Shown on the Integrations page as "Recent provider errors". |
| **Contact support** from within the app? | **Yes.** "Help & support" in the sidebar on every signed-in page, a Support link on the sign-in page, and a "Report this" link beside every logged error that opens an email with the `intuit_tid` filled in. `/support` is public, like the legal pages, so somebody locked out can still reach it. |
| Which **API categories**? | **Accounting API** only. Scope `com.intuit.quickbooks.accounting`. Payroll is paid through VEEM and card payments through Stripe — neither touches Intuit's Payroll or Payments APIs. |
| How often are the APIs **called per customer**? | **Daily.** In practice every 10 minutes (`SYNC_INTERVAL_MINUTES`). An incremental sync is **two calls** — one Account query and one CDC request — so roughly 290 a day for AHN's one company. A first sync, or one after a gap longer than 29 days, uses the full query path once. |

**Why a dead token is not retried.** Intuit answers `400` both for
`invalid_grant` (the refresh token is gone — the customer must reconnect) and
for `invalid_client` (our own keys are wrong — reconnecting changes nothing).
The body is read to tell them apart, because giving the same advice for both
would send somebody to reauthorise over a wrong `QBO_CLIENT_SECRET`.

**This is a private app, not an App Store listing.** AHN connects its own
QuickBooks company, so no Intuit SSO is implemented on the Launch URL: arriving
from QuickBooks decides where you land, never whether you are let in. If AHN
ever publishes to the Intuit App Store, OpenID Connect SSO becomes a
requirement and the Launch URL has to be rewritten.

---

## 2. Deploy the scheduler to Railway

New project → **Deploy from GitHub repo** → this repository.

### Settings

| Setting | Value | Why |
|---|---|---|
| **Root Directory** | `worker` | The only setting that is not optional. Without it Railway builds from the repo root, installs Next.js, React and everything else for a worker that imports one Node built-in — and Nixpacks, seeing a Next.js app, may try `next build`, which needs the app's environment and fails confusingly. |
| **Start Command** | *(leave blank)* | [`worker/railway.json`](../worker/railway.json) sets `node index.mjs`. |
| **Healthcheck Path** | *(leave blank)* | Same file sets `/health`. |
| **Builder** | Nixpacks (default) | |
| **Public Networking** | enable | So `/health` is reachable. Nothing else is served. |

[`worker/`](../worker/) is self-contained — its own `package.json` with **zero
dependencies** and its own `railway.json`. `npm install` there is instant, and
the worker cannot accidentally reach into application code.

[`.railwayignore`](../.railwayignore) keeps the upload to `worker/` alone.
Railway uploads the whole repository before building from the Root Directory, so
without it the app's `package-lock.json` travels along — and Railway's dependency
scanner reads that lockfile and blocks the build over advisories in packages the
worker never loads.

### Variables

Add these under **Variables**:

| Variable | Value | |
|---|---|---|
| `APP_URL` | `https://your-app.vercel.app` | required |
| `CRON_SECRET` | **the same string the app has** | required |
| `SYNC_INTERVAL_MINUTES` | `10` | optional |
| `DIGEST_HOUR` | `9` | optional, local hour |
| `WEEKLY_DIGEST_DAY` | `1` (Monday) | optional |
| `TZ` | `Asia/Ho_Chi_Minh` | optional — decides what "9am" means |

Without `TZ` the container runs UTC, so a `DIGEST_HOUR` of 9 fires at 16:00 in
Vietnam. Set it deliberately.

**Set `BUSINESS_TIME_ZONE` on the app to the same value.** `TZ` decides when the
worker *fires*; `BUSINESS_TIME_ZONE` decides what date the app calls "today"
when it answers. If they disagree, the digest fires at 9am Vietnam and reports
figures dated to whatever UTC thought the day was — which for the first seven
hours of every Vietnamese day is yesterday. Stored dates are UTC either way; see
decision 84.

Do not set `PORT` — Railway assigns it, and the worker reads it.

`/health` reports the timezone the process is **actually** resolved to, not the
value of `TZ`. Those can differ, and the one that decides when the digest fires
is the resolved zone:

```json
{ "timezone": "Asia/Ho_Chi_Minh", "nextDigestLocalTime": "09:00 Asia/Ho_Chi_Minh" }
```

The worker needs no database access, no Supabase keys and no provider
credentials. It knows a URL and a shared secret, and nothing else — so a
compromise of the scheduler exposes far less than a compromise of the app.

### Confirming it works

`https://<worker>.up.railway.app/health` returns the state of each job:

```json
{
  "ok": true,
  "target": "https://your-app.vercel.app",
  "syncEveryMinutes": 10,
  "jobs": {
    "sync": { "runs": 42, "failures": 0, "lastRun": "…", "lastStatus": 200, "lastError": null }
  }
}
```

It answers **503** once any job has failed, so Railway's health check restarts a
worker that has lost the app rather than leaving it quietly dead. A wrong
`CRON_SECRET` shows up immediately:

```
sync FAILED  401  {"error":"Unauthorized."}
```

The logs summarise each run rather than dumping JSON:

```
sync ok  3 new, 1 duplicates flagged, 3 alerted
sync ok  nothing to do
```

---

## 3. Verify the whole deployment

```bash
npm run smoke -- you@example.com 'password' https://your-app.vercel.app
```

Signs in and loads every page as a real owner. Nothing else in the test suite
does this — the unit and integration tests call the calc engine directly, so a
page that throws while rendering those numbers passes all of them, and
`next build` misses it too because every page is server-rendered on demand.

---

## Before the first real sync

- **Clear the demo data**: `npm run db:seed -- --reset --reset-only`. It removes
  only what the seeder wrote — rows keyed `demo-%` and the accounts it created,
  including their reported balances. Real connector data is untouched.
- **Check `ALERT_MAX_AGE_DAYS`** (default 3). The first sync of a source
  backfills ~180 days; without the horizon that is hundreds of alerts in one
  burst about money that moved months ago. Older rows are still ingested and
  still counted — they are marked as seen rather than announced.
- **Run the migrations** against the production database: `npm run db:push`, or
  paste `supabase/setup-all.sql` into the Supabase SQL editor.
